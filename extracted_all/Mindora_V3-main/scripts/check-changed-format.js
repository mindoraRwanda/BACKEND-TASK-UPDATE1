import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const supportedExtensions = new Set([
  '.ts',
  '.js',
  '.json',
  '.md',
  '.yml',
  '.yaml',
]);
const prettierIgnore = path.join(projectRoot, '.prettierignore');

function runGit(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: options.cwd ?? projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    throw new Error(
      `Git comparison failed: ${detail || error.message}. Ensure the required commits and history are available.`
    );
  }
}

function assertCommitExists(revision, description) {
  if (!/^[0-9a-f]{40,64}$/i.test(revision ?? '')) {
    throw new Error(`${description} commit SHA is missing or invalid.`);
  }

  runGit(['cat-file', '-e', `${revision}^{commit}`]);
}

function parseNameStatus(output) {
  const tokens = output.split('\0');
  const paths = [];
  let deletedCount = 0;

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;

    if (/^[RC]/.test(status)) {
      index++; // Previous path; check the destination path below.
      const destination = tokens[index++];
      if (destination) paths.push(destination);
    } else {
      const filePath = tokens[index++];
      if (!filePath) continue;
      if (status === 'D') deletedCount++;
      else paths.push(filePath);
    }
  }

  return { paths, deletedCount };
}

function collectWorkingTreeChanges(repoRoot) {
  const diff = runGit(
    ['diff', '--name-status', '-z', '--find-renames', 'HEAD'],
    { cwd: repoRoot }
  );
  const parsed = parseNameStatus(diff);
  const untracked = runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot }
  )
    .split('\0')
    .filter(Boolean);

  return {
    paths: [...parsed.paths, ...untracked],
    deletedCount: parsed.deletedCount,
    comparison:
      'working tree against HEAD, including staged and untracked files',
  };
}

function collectEventChanges(repoRoot) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName) {
    throw new Error(
      'GITHUB_EVENT_NAME is unavailable. In CI, provide the GitHub event context; locally, use --working-tree.'
    );
  }
  if (!eventPath || !existsSync(eventPath)) {
    throw new Error(
      'GITHUB_EVENT_PATH is unavailable. Cannot determine the changed-file comparison range.'
    );
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read GitHub event payload: ${error.message}`);
  }

  let base;
  let head;
  let useMergeBase = false;
  let comparison;

  if (eventName === 'pull_request') {
    base = payload.pull_request?.base?.sha;
    head = payload.pull_request?.head?.sha;
    useMergeBase = true;
    comparison = 'pull request base to head';
  } else if (eventName === 'push') {
    base = payload.before;
    head = payload.after;
    comparison = 'push before to after';
    if (/^0+$/.test(base ?? '')) {
      throw new Error(
        'The push event has an all-zero before SHA, so there is no prior commit to compare. Formatting check cannot continue.'
      );
    }
  } else if (eventName === 'workflow_dispatch') {
    const defaultBranch = payload.repository?.default_branch;
    if (!defaultBranch || defaultBranch.startsWith('-')) {
      throw new Error(
        'The workflow_dispatch payload has no usable repository default branch for comparison.'
      );
    }
    base = runGit([
      'rev-parse',
      '--verify',
      `refs/remotes/origin/${defaultBranch}^{commit}`,
    ]).trim();
    head = process.env.GITHUB_SHA;
    useMergeBase = true;
    comparison = `default branch origin/${defaultBranch} to dispatched commit`;
  } else {
    throw new Error(
      `Unsupported GitHub event "${eventName}". Formatting check requires a PR, push, or workflow_dispatch comparison.`
    );
  }

  assertCommitExists(base, 'Base');
  assertCommitExists(head, 'Head');

  const diffArgs = ['diff', '--name-status', '-z', '--find-renames'];
  if (useMergeBase) diffArgs.push('--merge-base');
  diffArgs.push(base, head);

  const parsed = parseNameStatus(runGit(diffArgs, { cwd: repoRoot }));
  return { ...parsed, comparison };
}

async function main() {
  const repoRoot = path.resolve(
    runGit(['rev-parse', '--show-toplevel']).trim()
  );
  const changes = process.argv.includes('--working-tree')
    ? collectWorkingTreeChanges(repoRoot)
    : collectEventChanges(repoRoot);

  const uniquePaths = [...new Set(changes.paths)];
  const candidates = [];
  let unsupportedCount = 0;
  let ignoredCount = 0;

  for (const gitPath of uniquePaths) {
    const relativePath = gitPath;
    if (!supportedExtensions.has(path.posix.extname(relativePath))) {
      unsupportedCount++;
      continue;
    }

    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
      throw new Error(`Git returned a path outside the repository: ${gitPath}`);
    }
    const projectRelativePath = path.relative(projectRoot, absolutePath);
    const inProjectWorkspace =
      projectRelativePath === '' ||
      (!projectRelativePath.startsWith(`..${path.sep}`) &&
        projectRelativePath !== '..' &&
        !path.isAbsolute(projectRelativePath));
    const ignorePath = inProjectWorkspace
      ? prettierIgnore
      : path.join(repoRoot, '.prettierignore');
    const info = await prettier.getFileInfo(absolutePath, {
      ...(existsSync(ignorePath) ? { ignorePath } : {}),
    });
    if (info.ignored) {
      ignoredCount++;
      continue;
    }

    let pathStats;
    try {
      pathStats = lstatSync(absolutePath);
    } catch {
      throw new Error(
        `Changed file ${relativePath} is missing from the checkout; refusing to skip its formatting check.`
      );
    }
    if (pathStats.isSymbolicLink()) {
      let resolvedPath;
      try {
        resolvedPath = realpathSync(absolutePath);
      } catch {
        throw new Error(
          `Changed symbolic link ${relativePath} has no resolvable target.`
        );
      }
      const relativeTarget = path.relative(repoRoot, resolvedPath);
      if (
        relativeTarget === '..' ||
        relativeTarget.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTarget)
      ) {
        throw new Error(
          `Changed symbolic link ${relativePath} resolves outside the repository.`
        );
      }
      if (!statSync(resolvedPath).isFile()) {
        throw new Error(
          `Changed symbolic link ${relativePath} does not resolve to a regular file.`
        );
      }
    } else if (!pathStats.isFile()) {
      throw new Error(
        `Changed path ${relativePath} is not a regular file; refusing to skip its formatting check.`
      );
    }

    if (!info.inferredParser) {
      throw new Error(`Prettier could not infer a parser for ${relativePath}.`);
    }
    candidates.push({ absolutePath, relativePath });
  }

  console.log(`Formatting comparison: ${changes.comparison}`);
  console.log(
    `Changed paths: ${uniquePaths.length}; deleted: ${changes.deletedCount}; unsupported: ${unsupportedCount}; ignored: ${ignoredCount}.`
  );

  if (candidates.length === 0) {
    console.log('No changed, supported, non-ignored files remain to check.');
    return;
  }

  const failures = [];
  for (const candidate of candidates) {
    const source = readFileSync(candidate.absolutePath, 'utf8');
    const options =
      (await prettier.resolveConfig(candidate.absolutePath, {
        editorconfig: true,
      })) ?? {};
    if (
      !(await prettier.check(source, {
        ...options,
        filepath: candidate.absolutePath,
      }))
    ) {
      failures.push(candidate.relativePath);
    }
  }

  if (failures.length > 0) {
    console.error(
      `Prettier found formatting issues in ${failures.length} changed file(s):`
    );
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Prettier passed for ${candidates.length} changed file(s).`);
}

main().catch((error) => {
  console.error(`Changed-file formatting check failed: ${error.message}`);
  process.exitCode = 1;
});
