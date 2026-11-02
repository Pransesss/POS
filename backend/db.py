"""Database connection helper (PostgreSQL via psycopg2)."""
import os
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://mmsu:mmsu123@localhost:5432/mmsu")
TIMEZONE = os.getenv("TIMEZONE", "Asia/Manila")


def connect():
    """New connection; rows come back as dictionaries (row['name'])."""
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
