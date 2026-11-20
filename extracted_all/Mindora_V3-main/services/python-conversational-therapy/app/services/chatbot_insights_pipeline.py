"""Optional emotion/medication analysis with a lightweight shared crisis pre-filter.

Transformer pipelines are lazy-loaded so importing the chatbot API does not download models
or block startup. Crisis checks do not depend on any transformer or network service.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any

from app.services.crisis_safety import assess_crisis_message, detect_suicide_risk

medication_keywords = [
    'lithium', 'prozac', 'zoloft', 'xanax', 'valium', 'lexapro', 'wellbutrin',
    'abilify', 'seroquel', 'celexa', 'paxil', 'effexor', 'lamictal'
]

def detect_medication_mentions(text: str) -> list[str]:
    lowered = text.lower()
    return [med for med in medication_keywords if med in lowered]

@lru_cache(maxsize=1)
def _load_classifiers():
    try:
        from transformers import pipeline
        return (
            pipeline('text-classification', model='j-hartmann/emotion-english-distilroberta-base', top_k=1),
            pipeline('sentiment-analysis', model='distilbert-base-uncased-finetuned-sst-2-english'),
            pipeline('text-classification', model='unitary/toxic-bert'),
        )
    except Exception:
        return (None, None, None)

def analyze_user_input(text: str) -> dict[str, Any]:
    # Crisis routing must not wait for transformer downloads or inference.
    assessment = assess_crisis_message(text)
    if assessment.is_crisis:
        return {
            'emotion': 'distress',
            'sentiment': 'N/A',
            'toxicity': 'N/A',
            'disorder_prediction': 'N/A',
            'medications_detected': detect_medication_mentions(text),
            'suicide_risk': 'high',
            'crisis_level': assessment.level,
            'crisis_category': assessment.category,
        }

    emotion_pipe, sentiment_pipe, toxicity_pipe = _load_classifiers()
    try:
        emotion = emotion_pipe(text)[0][0]['label'] if emotion_pipe else 'N/A'
        sentiment = sentiment_pipe(text)[0]['label'] if sentiment_pipe else 'N/A'
        toxicity = toxicity_pipe(text)[0]['label'] if toxicity_pipe else 'N/A'
    except Exception:
        emotion = sentiment = toxicity = 'N/A'
    return {
        'emotion': emotion,
        'sentiment': sentiment,
        'toxicity': toxicity,
        'disorder_prediction': 'N/A',
        'medications_detected': detect_medication_mentions(text),
        'suicide_risk': 'high' if assessment.is_crisis else 'low',
        'crisis_level': assessment.level,
        'crisis_category': assessment.category,
    }

def load_and_index_datasets() -> None:
    """Explicit opt-in indexing task; never triggered on app startup."""
    from datasets import load_dataset
    from langchain_community.vectorstores import Chroma
    from langchain_community.embeddings import HuggingFaceEmbeddings
    from langchain.text_splitter import RecursiveCharacterTextSplitter
    from langchain.docstore.document import Document

    datasets_to_load = [
        ('tolu07/Mental_Health_FAQ', 'FAQ'),
        ('vivekdugale/llama2_mental_health_dataset_172', 'LLaMA2 Dialogues'),
        ('jtatman/mental_health_psychology_curated_alpaca', 'Alpaca Instructions'),
        ('sayanroy058/Social_Media_And_Twitter_Mental_Health_Dataset', 'Social Media Risk'),
    ]
    all_docs = []
    for dataset_name, label in datasets_to_load:
        try:
            ds = load_dataset(dataset_name)
            for row in ds['train']:
                row_text = '\n'.join(str(value) for value in row.values())
                all_docs.append(Document(page_content=row_text, metadata={'source': label}))
        except Exception:
            # Do not leak remote dataset rows or credentials in logs.
            continue
    splitter = RecursiveCharacterTextSplitter(chunk_size=300, chunk_overlap=30)
    chunks = splitter.split_documents(all_docs)
    embedding_model = HuggingFaceEmbeddings(model_name='sentence-transformers/all-MiniLM-L6-v2')
    vectorstore = Chroma.from_documents(chunks, embedding_model, persist_directory='./mental_health_knowledge')
    vectorstore.persist()
