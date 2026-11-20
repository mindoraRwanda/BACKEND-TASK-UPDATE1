FROM python:3.10-slim

WORKDIR /app

# Add git, build tools, CMake, etc.
RUN apt-get update && apt-get install -y \
    git \
    gcc \
    g++ \
    cmake \
    make \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
