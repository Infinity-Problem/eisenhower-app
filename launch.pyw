"""Entry point for the Eisenhower app.

Using .pyw so pythonw.exe runs it without spawning a console.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from app import main

if __name__ == "__main__":
    main()
