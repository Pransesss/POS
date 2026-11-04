# Hugging Face Space (Docker) / any container host. Serves the API and the pages on port 7860.
FROM python:3.12-slim
RUN useradd -m -u 1000 user
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY --chown=user . .
RUN mkdir -p /data/uploads/logos && chown -R user /data
USER user
ENV PORT=10000 TF_CPP_MIN_LOG_LEVEL=2 UPLOADS_DIR=/data/uploads
EXPOSE 10000
WORKDIR /app/backend
CMD ["sh", "-c", "exec gunicorn -b 0.0.0.0:${PORT:-10000} -w 1 --threads 4 --timeout 180 app:app"]