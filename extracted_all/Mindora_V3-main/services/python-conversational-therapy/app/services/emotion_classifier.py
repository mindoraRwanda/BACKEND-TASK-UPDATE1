"""Lazy emotion classifier; model downloads happen only when classification is requested."""
from __future__ import annotations

from functools import lru_cache

emotion_examples = {
    'sadness': [
        'I feel like crying all the time.', 'Nothing makes me happy anymore.',
        'I am tired of everything.', 'I do not see the point in anything.',
        'I feel so low I cannot get out of bed.'
    ],
    'anxiety': [
        'I am always overthinking everything.', 'I cannot calm down, my mind will not stop racing.',
        'I am scared something bad will happen.', 'I feel shaky and nervous all day.'
    ],
    'stress': [
        'I feel like I am drowning in responsibilities.', 'Everything is too much right now.',
        'I feel burned out.', 'I am overwhelmed and cannot focus.'
    ],
    'fear': ['I am terrified.', 'I had a panic attack earlier.', 'I feel unsafe.', 'I am afraid something is going to go wrong.'],
    'anger': ['I get irritated at everyone.', 'I feel like screaming.', 'Everything makes me mad.', 'I cannot control my temper.'],
    'guilt': ['I feel ashamed.', 'I cannot forgive myself.', 'I feel like a failure.'],
    'craving': ['I really want to drink again.', 'The urge to use is too strong.', 'I keep going back to old habits.'],
    'numbness': ['I do not feel anything anymore.', 'I feel empty inside.', 'Nothing matters to me now.'],
    'joy': ['Today actually felt okay.', 'I laughed and it felt good.', 'Something good happened.'],
    'neutral': ['Hello', 'Hi', 'How are you?', 'Just checking in.'],
}

@lru_cache(maxsize=1)
def _get_model_and_embeddings():
    import torch
    from sentence_transformers import SentenceTransformer, util
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = SentenceTransformer('BAAI/bge-small-en', device=device)
    embeddings = {label: model.encode(prompts, convert_to_tensor=True)
                  for label, prompts in emotion_examples.items()}
    return model, embeddings, util, torch

def classify_emotion(user_input: str) -> str:
    try:
        model, embeddings, util, torch = _get_model_and_embeddings()
        vector = model.encode(user_input, convert_to_tensor=True)
        scores = {label: torch.mean(util.cos_sim(vector, examples)).item()
                  for label, examples in embeddings.items()}
        best_label = max(scores, key=scores.get)
        return best_label if scores[best_label] >= 0.35 else 'neutral'
    except Exception:
        # Emotion analysis is auxiliary and must not block crisis support or chat availability.
        return 'neutral'
