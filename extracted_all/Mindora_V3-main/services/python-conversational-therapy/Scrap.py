import os
import requests
from googlesearch import search

# Target folder to save the PDFs
save_path = "C:/Users/STUDENT/Documents/MentalHealthChatbot" 
os.makedirs(save_path, exist_ok=True)

# List of search queries to automate
queries = [
    # Screening tools
    "PHQ-9 depression questionnaire site:who.int filetype:pdf",
    "GAD-7 anxiety assessment site:who.int filetype:pdf",
    "AUDIT alcohol use screening site:who.int filetype:pdf",
    "PCL-5 PTSD checklist site:samhsa.gov filetype:pdf",
    "mental health screening tool site:apa.org filetype:pdf",
    "psychological assessment Rwanda site:rbc.gov.rw filetype:pdf",
]
# Number of search results per query
num_results = 10

# Function to download PDF files
def download_pdf(url, save_folder):
    try:
        response = requests.get(url, timeout=10)
        if response.headers.get("content-type", "").lower().startswith("application/pdf"):
            filename = url.split("/")[-1].split("?")[0]
            file_path = os.path.join(save_folder, filename)
            with open(file_path, "wb") as f:
                f.write(response.content)
            return filename
    except Exception as e:
        print(f"[ERROR] Failed to download {url}: {e}")
    return None

# Run through each query and download PDF results
all_downloaded = []
for query in queries:
    print(f"\nSearching for: {query}")
    for result_url in search(query, num_results=num_results):
        if result_url.endswith(".pdf"):
            filename = download_pdf(result_url, save_path)
            if filename:
                print(f" Downloaded: {filename}")
                all_downloaded.append(filename)

print("\n Total PDFs downloaded:", len(all_downloaded))
