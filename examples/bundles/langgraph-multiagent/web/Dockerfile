FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV PORT=8080 AGENT_URL=http://agent:8000
EXPOSE 8080
CMD ["sh","-c","python -m flask run --host 0.0.0.0 --port ${PORT}"]
