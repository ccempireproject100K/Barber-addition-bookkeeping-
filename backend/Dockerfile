FROM python:3.11-slim
WORKDIR /app
COPY requirements.selfhost.txt .
RUN pip install --no-cache-dir -r requirements.selfhost.txt
COPY . .
EXPOSE 8001
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
