.PHONY: test run docker-build

test:
	npm test

run:
	npm start

docker-build:
	docker build -t usr-0912014102-q002 .
