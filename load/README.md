# Load tests

[k6](https://grafana.com/docs/k6/) scripts that drive the docker compose stack. k6 runs in a container on the
compose network, so nothing has to be installed on the host. Results of the runs so far are recorded in
[ADR 0011](../docs/adr/0011-load-test-and-capacity.md).

## `ingest.js`: ingestion latency and freshness

Sends `POST /locations` at a constant arrival rate, then reads the services' Prometheus metrics to check both
targets of SPEC §11:

| Check                                          | Source                                                    | Threshold                   |
| ---------------------------------------------- | --------------------------------------------------------- | --------------------------- |
| `POST /locations` latency seen by the client   | k6 (`http_req_duration`)                                  | p99 < 50 ms                 |
| `POST /locations` latency inside the service   | api `http_request_duration_seconds`, bucket `le="0.05"`   | ≥ 99 % of requests          |
| Ping accepted in the API → processed in worker | worker `location_ping_processing_delay_seconds`, `le="1"` | ≥ 99 % of pings             |
| Every ping answered `202`                      | k6 checks                                                 | > 99.9 %                    |
| The system kept up with the rate               | k6 `dropped_iterations`                                   | ≤ 0.1 % of planned requests |

The service-side shares are read at a bucket boundary of the histograms, so they are exact, not interpolated.

Simulated users move along a route; one user in ten crosses four areas the script creates (named
`load-test-area-1` … `4`; reused on later runs), so the worker records entries and exits as well.

### Run

```bash
docker compose --profile app up -d --build
docker compose run --rm k6 run /load/ingest.js
docker compose run --rm k6 run -e RATE=1250 -e DURATION=2m /load/ingest.js
```

k6 exits with code 99 when a threshold is crossed. Options are passed with `-e NAME=value`; they are listed at
the top of the script (`RATE`, `DURATION`, `USERS`, `APIS`, `WORKERS`, `BASE_URL`, `API_KEY`).

### Several api and worker containers

The api and the worker publish fixed host ports, which replicas cannot share. `compose.scale.yml` removes them;
k6 reaches the containers on the compose network, where `api` resolves to every api container:

```bash
docker compose -f docker-compose.yml -f load/compose.scale.yml --profile app up -d --scale api=2 --scale worker=2
docker compose run --rm k6 run -e RATE=2500 -e APIS=2 -e WORKERS=2 /load/ingest.js
```

`APIS` and `WORKERS` tell the script how many containers to read metrics from. Afterwards, restore the normal
stack (one container each, host ports published):

```bash
docker compose --profile app up -d --scale api=1 --scale worker=1
```

### Worker throughput

To measure how fast one worker processes a backlog, stop it, build a backlog, then start it and watch
`location_pings_processed_total` on `http://localhost:3001/metrics`:

```bash
docker compose stop worker
docker compose run --rm k6 run -e RATE=1200 -e DURATION=100s -e WORKERS=0 /load/ingest.js
docker compose start worker
```

### In Kubernetes

The same script runs as a Job inside a cluster, against the API Service; see
[deploy/k8s/README.md](../deploy/k8s/README.md). Pods are not reachable by container name there, so it runs with
`APIS=0 WORKERS=0` and checks the client side only.

### Reading the results

- Everything (k6, Kafka, PostgreSQL, Redis, the services) shares one machine. Watch `docker stats` during a run:
  once the host is out of CPU, the numbers describe the machine, not the service.
- Git Bash on Windows rewrites `/load/ingest.js` into a Windows path; run the commands from PowerShell, or set
  `MSYS_NO_PATHCONV=1` in Git Bash first.
