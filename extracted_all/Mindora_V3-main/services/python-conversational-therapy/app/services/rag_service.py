from pathlib import Path
import os
from sentence_transformers import SentenceTransformer
from langchain.text_splitter import RecursiveCharacterTextSplitter
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, VectorParams, Distance
import uuid
import fitz  # PyMuPDF

# Define the folder containing your PDF documents
# pdf_folder = Path("../../datasources")
pdf_folder = Path(os.getenv("RAG_PDF_FOLDER", str(Path(__file__).resolve().parents[2] / "datasources")))

# Define the name of the Qdrant collection to store document chunks
collection_name = os.getenv("QDRANT_COLLECTION", "therapy_knowledge_base")

# Load the sentence-transformer model to convert text into dense embeddings
embedder = SentenceTransformer("all-MiniLM-L6-v2")

# Initialize the Qdrant client to connect to the local vector database
qdrant = QdrantClient(host=os.getenv("QDRANT_HOST", "localhost"), port=int(os.getenv("QDRANT_PORT", "6333")))

# If the collection doesn't exist, create it with appropriate vector settings
if not qdrant.collection_exists(collection_name):
    qdrant.create_collection(
        collection_name=collection_name,
        vectors_config=VectorParams(
            size=384,  # Dimension must match the model's embedding size
            distance=Distance.COSINE  # Use cosine similarity for semantic search
        )
    )

# Initialize a text splitter to break long documents into smaller chunks
splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,      # Max characters per chunk
    chunk_overlap=50     # Overlap to preserve context between chunks
)

# Print the PDF files found in the target folder
print("Files found:", list(pdf_folder.glob("*.pdf")))

# Loop through each PDF file for processing
for file in pdf_folder.glob("*.pdf"):
    print(f"\nProcessing file: {file.name}")

    try:
        # Open and read all text from the PDF file
        doc = fitz.open(file)
        full_text = "\n".join([page.get_text() for page in doc])
        doc.close()

        # Split the full document text into smaller overlapping chunks
        chunks = splitter.split_text(full_text)
        print(f"Split into {len(chunks)} chunks")

        # Generate embeddings (numerical vectors) for each chunk
        embeddings = embedder.encode(chunks).tolist()

        # Create Qdrant-compatible Point objects to store each chunk and vector
        points = []
        for i, (chunk, vector) in enumerate(zip(chunks, embeddings)):
            unique_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{file.name}_{i}"))
            points.append(PointStruct(
                id=unique_id,
                vector=vector,
                payload={
                    "source": file.name,
                    "chunk_id": i,
                    "text": chunk
                }
            ))

        # Upload the chunks with embeddings and metadata to Qdrant
        qdrant.upsert(
            collection_name=collection_name,
            points=points
        )
        print(f"Uploaded {len(points)} chunks to Qdrant.")

    except Exception as e:
        print(f"Error processing {file.name}: {e}")
