# Hugging Face Space (Docker) / any container host. Serves the API and the pages on port 7860.
FROM python:3.12-slim
RUN useradd -m -u 1000 user
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY --chown=user . .
RUN mkdir -p backend/uploads/logos && chown -R user /app
USER user
ENV PORT=7860 TF_CPP_MIN_LOG_LEVEL=2
EXPOSE 7860
WORKDIR /app/backend
CMD ["gunicorn", "-b", "0.0.0.0:7860", "-w", "1", "--threads", "4", "--timeout", "180", "app:app"]
