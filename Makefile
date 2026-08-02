.PHONY: install migrate test build start

install:
	python -m pip install -r apps/api/requirements.txt
	cd apps/web && pnpm install --frozen-lockfile

migrate:
	cd apps/api && alembic upgrade head

test:
	python -m pytest tests -q
	cd apps/web && pnpm test

build:
	cd apps/web && pnpm build

start: build migrate
	cd apps/api && uvicorn app.main:app --host 127.0.0.1 --port 8000
