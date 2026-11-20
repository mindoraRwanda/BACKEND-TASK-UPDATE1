# MINDORA hosting options — indicative comparison

**Checked:** 1 November 2026. Prices are USD before tax and usage overages. These are public list prices, not a quote for MINDORA's measured workload.

## Options

| Layer / provider        |                                   Public entry cost | Fit and limits for MINDORA                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel Hobby            |                                            $0/month | Personal/non-commercial plan. Not appropriate for a commercial mental-health service. Vercel Pro starts at $20/month and includes $20 usage credit; actual compute/transfer can add charges.                                                                                                    |
| Netlify Free            |                                            $0/month | 300 usage credits/month; projects can pause when the monthly credit limit is reached. Suitable for previews/staging or a very small static site, not a guarantee of always-on production service. Personal is $9/month with 1,000 credits; Pro starts at $20/month with at least 3,000 credits. |
| MongoDB Atlas M0        |                                            $0/month | 512 MB, shared resources, restricted feature set; marketed for learning/exploration. Do not move sensitive production patient data here without a security, backup, region, access-control and workload assessment.                                                                             |
| MongoDB Atlas Flex      |                                        $8–$30/month | 5 GB and up to 500 operations/second by usage tier; shared resources. Potential low-cost candidate only if the application workload and operational needs fit.                                                                                                                                  |
| MongoDB Atlas Dedicated |                             From about $56.94/month | Dedicated tier starting price shown on the public pricing page; configuration, region, backups and network options affect final bill.                                                                                                                                                           |
| Render Free             |                                            $0/month | Test/preview only. Free web services spin down after 15 minutes idle; wake-up can take about a minute; free filesystems are ephemeral; free Postgres expires after 30 days. Render explicitly says not to use free instances for production.                                                    |
| Fly.io shared-cpu-1x    | From about $2.02/month for 256 MB in listed regions | Per running Machine, billed by region and size; 512 MB and 1 GB cost more, and storage, bandwidth, IPs and attached services add cost. A single 256 MB machine is not a safe sizing assumption for a MINDORA microservice.                                                                      |
| Resend Free             |                                            $0/month | 3,000 emails/month, 100/day; sufficient for initial notification-volume testing if sender verification and recipient policy are completed. Pro $20/month for 50,000/month.                                                                                                                      |
| Africa's Talking SMS    |                       Variable by destination/route | SMS needs a funded account, approved sender ID where applicable, valid Rwandan destinations and real delivery tests. Obtain a Rwanda-specific rate/quote before estimating a monthly SMS bill.                                                                                                  |

## Recommendation

1. **Do not migrate production yet.** First capture 30 days of current Railway spend, service CPU/RAM, network, storage, database, Redis, RabbitMQ, backup and egress use.
2. Use Netlify/Vercel free tiers only for preview or non-commercial test surfaces. For the commercial frontend, compare Netlify Personal/Pro and Vercel Pro against actual Next.js usage, image optimization, build volume, bandwidth and domain needs.
3. Do not assume one Fly.io 256 MB machine can replace nine microservices. Price each service after measuring memory/CPU, then add managed database, Redis/RabbitMQ, persistent storage, backups, egress and redundancy.
4. Render Free is not acceptable for production because of spin-down, ephemeral filesystem and short-lived free database limits. Price paid instances and persistent data separately.
5. Keep MongoDB Atlas M0 for dev only. Compare Flex/Dedicated with current MongoDB workload and confirm that production databases (PostgreSQL, MongoDB, Redis) can be securely backed up and restored.
6. Resend Free is a reasonable starting email option within 3,000/month and 100/day. Alert inboxes for a clinical crisis workflow must be monitored and delivery failures tested. Email/SMS provider charges are separate from hosting.

## Decision gate before migration

- Export and verify database backups and restore procedure.
- Recreate all secrets in the target platform; never copy a `.env` file into Git or ZIP releases.
- Test private file/object storage, signed URLs, SSL, CORS, cookies, WebSockets, queues, cron jobs, email/SMS, logs and alerting.
- Run a staging load test and a rollback exercise.
- Obtain written MINDORA approval before changing DNS or moving any production database/service.

## Official pricing references

- Vercel plans: https://vercel.com/pricing
- Netlify plans and credits: https://www.netlify.com/pricing/
- MongoDB Atlas pricing: https://www.mongodb.com/pricing
- MongoDB Atlas Flex pricing: https://www.mongodb.com/docs/atlas/billing/atlas-flex-costs/
- Render Free limitations: https://render.com/docs/free
- Fly.io machine pricing: https://fly.io/docs/about/pricing/
- Resend pricing: https://resend.com/pricing

Pricing changes. Re-check provider pages and actual account calculators immediately before any commercial commitment.
