# PreventVital OCR backend — Docker image for Render free web service.
# Installs the two system binaries the pipeline spawns:
#   tesseract-ocr   (image OCR)          poppler-utils  (pdftotext for text-layer PDFs)

FROM node:24-slim

# System deps: tesseract OCR engine + poppler's pdftotext.
# tesseract-ocr-eng = English language pack for OCR.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
 && rm -rf /var/lib/apt/lists/*

# Build context = REPO ROOT (see render.yaml dockerContext).
# Container layout MIRRORS THE REPO: code in /app/backend, schema in /app/schema.
# extract.js/pipeline.js read path.posix.join(__dirname, '..', 'schema', 'Lab_Test_Schema.json')
# which resolves to /app/schema/Lab_Test_Schema.json — exactly where COPY puts it.
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ .
COPY schema/ /app/schema/

# Linux paths for the binaries (extract.js falls back to PATH lookup).
ENV TESSERACT_PATH=/usr/bin/tesseract

EXPOSE 8080
# Render web services get PORT via env; PORT is honored (8080 locally).
CMD ["sh", "-c", "PORT=${PORT:-8080} node index.js"]
