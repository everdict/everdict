# Command server (dummy benchmark front door) — publishes dummy agent chat onto Redis Streams and
# verifies the transcript the client reports back. Build: docker build -t sse-relay-command:v1 .
FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
