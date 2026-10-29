# FastAPI and Django

Create an isolated environment, install the local SDK and this example, then choose either server:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -e ../../../sdks/python -e .
python -m uvicorn fastapi_app:app --port 8080
# or: python manage.py runserver 8080
```

Call `GET /files/ENTRY_ID` with an `X-App-User` header after setting the common variables in the
parent framework README.
