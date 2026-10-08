# Kubernetes

Kustomize manifests for the service. Decisions are recorded in
[ADR 0012](../../docs/adr/0012-kubernetes-deployment.md).

| Path                   | Contents                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base/`                | The production shape: API and worker Deployments, the API Service, an HPA (API, CPU), a KEDA ScaledObject (worker, consumer lag), PodDisruptionBudgets, and the migration and topic jobs |
| `overlays/local/`      | A self-contained deployment for a local cluster: the base plus PostgreSQL/PostGIS, Kafka and Redis in the cluster, development secrets and small resource requests                       |
| `overlays/production/` | An example environment overlay: the base pointed at managed services (placeholder host names), the image from a registry                                                                 |
| `kind/`                | Helpers for a local kind cluster: the metrics-server patch and the load test as a Job                                                                                                    |
| `smoke-test.sh`        | End-to-end check of a deployment (bash; used by CI): creates an area, sends pings, waits for the entry in `GET /logs`                                                                    |

## Deploying to a production cluster

The base expects:

- **Managed PostgreSQL (with PostGIS), Kafka and Redis.** An overlay per environment sets `POSTGRES_HOST`, `KAFKA_BROKERS`
  (fully qualified: KEDA's operator reads it from its own namespace) and `REDIS_URL` in the
  `location-tracking-config` ConfigMap, and the image tag (`images:`; prefer a digest).
- **A Secret `location-tracking-secrets`** with `POSTGRES_USER`, `POSTGRES_PASSWORD` and `API_KEYS`, created by the
  platform's secret manager (e.g. External Secrets). It is never committed.
- **metrics-server** (for the HPA) and **KEDA** in the cluster. A Kafka cluster with authentication also needs a KEDA
  `TriggerAuthentication` referenced by the ScaledObject's trigger.
- **A gateway or ingress** in front of the `location-tracking-api` Service, routing only the public API. `/health/*`,
  `/metrics` and `/docs` are for the cluster, not for clients.

A deployment runs the one-off jobs, then rolls out the new pods. Jobs are immutable, so the previous run is deleted
first:

```bash
kubectl -n location-tracking delete job location-tracking-migrate location-tracking-provision-topics --ignore-not-found
kubectl apply -k deploy/k8s/overlays/production
kubectl -n location-tracking wait --for=condition=complete job --all --timeout=600s
kubectl -n location-tracking rollout status deployment/location-tracking-api
kubectl -n location-tracking rollout status deployment/location-tracking-worker
```

The rollout starts while the migration runs. That is safe because schema changes are backward compatible (expand, then
contract in a later release): the old pods keep working on the new schema, and the new pods start without the database
anyway (they connect in the background).

## Trying it on a local kind cluster

Prerequisites: Docker and [kind](https://kind.sigs.k8s.io/) (`winget install Kubernetes.kind`, `brew install kind`
or the release binary). The cluster with the service uses about 3.5 GB of Docker's memory; stop the compose stack
first (`docker compose --profile app stop`). Every command runs as-is in PowerShell, bash and zsh.

```bash
kind create cluster --name location-tracking
docker compose --profile app build api
kind load docker-image location-tracking-service:local --name location-tracking
```

metrics-server (the HPA's CPU source; kind's kubelets have self-signed certificates) and KEDA:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.0/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json --patch-file deploy/k8s/kind/metrics-server-patch.json
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.21.0/keda-2.21.0.yaml
kubectl -n keda wait --for=condition=Available deployment --all --timeout=300s
```

The service:

```bash
kubectl apply -k deploy/k8s/overlays/local
kubectl -n location-tracking wait --for=condition=complete job --all --timeout=600s
kubectl -n location-tracking get pods
kubectl -n location-tracking port-forward svc/location-tracking-api 8080:80
```

The API is then on `http://localhost:8080` (Swagger UI at `/docs`; API key `local-development-api-key-change-me-0123456789`).
The first job attempts may fail while PostgreSQL and Kafka start; the jobs retry with back-off.

### Watching the autoscalers

In a second terminal, `kubectl -n location-tracking get hpa,deployment --watch`. Then run the load test inside the
cluster (300 pings/s for 4 minutes):

```bash
kubectl -n location-tracking create configmap k6-ingest --from-file=load/ingest.js
kubectl -n location-tracking apply -f deploy/k8s/kind/k6-job.yaml
kubectl -n location-tracking logs job/k6-ingest --follow
```

The API's HPA adds pods as their CPU exceeds 65 % of the request. To see KEDA react to consumer lag, pause the worker
before the load test, and release it a minute later:

```bash
kubectl -n location-tracking annotate scaledobject location-tracking-worker autoscaling.keda.sh/paused-replicas=0
kubectl -n location-tracking annotate scaledobject location-tracking-worker autoscaling.keda.sh/paused-replicas-
kubectl -n location-tracking exec kafka-0 -- /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group entry-detector
```

Clean up with `kind delete cluster --name location-tracking`, then `docker compose --profile app start`.
