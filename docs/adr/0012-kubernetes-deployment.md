# ADR 0012 — Delivery: Kubernetes manifests, autoscaling and the CI pipeline

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The service runs as two process roles from one image (ADR 0001). The API must scale with the ping rate (~1,100
pings/s per core, ADR 0011), the worker with its backlog, and neither may lose requests or messages during a
deployment or a node drain (ADR 0010). Changes must be checked automatically before they reach a cluster.

## Decisions

### Kustomize, a production base and overlays

`deploy/k8s/base` holds the production shape; overlays adapt it per environment (`overlays/production` as an example
pointed at managed services, `overlays/local` for a kind cluster with PostgreSQL, Kafka and Redis inside it).
Kustomize ships with `kubectl` and keeps the manifests plain YAML. A Helm chart would add templating and a release
history, which pays off when many teams install the same chart with different values; one service with a few
environments does not need it.

Configuration is a generated ConfigMap whose name carries a hash of its content, so a configuration change rolls the
pods. Secrets are created by the platform's secret manager and never committed; only the local overlay generates
development values.

### Autoscaling: the API on CPU, the worker on consumer lag

- **API: HorizontalPodAutoscaler on CPU, target 65 % of a one-core request, 3 to 30 pods.** The API's limit is its
  JavaScript thread (ADR 0011), so CPU tracks load directly. 65 % keeps instances below the point where queueing
  makes latency climb. Scaling up may double the pods every 30 s; scaling down waits for 5 calm minutes.
- **Worker: KEDA ScaledObject on the lag of `entry-detector`, target 2,000 messages per pod, 3 to 24 pods.** While
  PostgreSQL is slow the worker's CPU falls although its backlog grows; CPU would scale it the wrong way. 24 is the
  partition count: more consumers would idle. KEDA reads the lag from the brokers, so it works even with no worker
  running. Scaling down is one pod per minute, because every change rebalances the consumer group.
- **Requests without CPU limits.** A pod asks for one core, the unit of capacity the HPA works with. A CPU limit would
  throttle a pod while its node has idle CPU and add latency; memory is limited (512 MiB, heap 384 MiB).

### Availability during changes

- Rolling updates add pods before removing any (`maxUnavailable: 0`). PodDisruptionBudgets let node drains take one
  pod of each role at a time.
- Pods spread over zones and nodes. The probes are the ones of ADR 0010: startup and liveness on `/health/live`,
  readiness on `/health/ready`. The grace period (30 s) exceeds the service's own shutdown bound (25 s).
- Migrations and topic creation are Jobs run by the pipeline before a rollout. The application pods need no DDL
  rights. Schema changes are backward compatible (expand, then contract), so old pods work on the new schema while
  the rollout runs.

### Processes start without PostgreSQL

The first deployment to kind started the pods before PostgreSQL was ready: the API waited ~30 s for the database
during startup, then exited. Kubernetes restarted it and it recovered, but the behaviour contradicted SPEC §10: ingestion
needs only Kafka, and an API pod rescheduled during a database outage would have stopped accepting pings too.
`DatabaseConnection` now awaits one attempt and then connects in the background; until connected, `/areas` and `/logs`
answer 503 and the worker's loops wait. On a fresh cluster the pods then started with no restart.

### Hardening

Pods run as a non-root user with a read-only root filesystem, no Linux capabilities, the runtime's seccomp profile
and no service account token. They meet the `restricted` Pod Security profile; the local namespace enforces
`baseline` (the development dependencies do not meet `restricted`) and warns about every pod that falls short of
it. Service links are off: Kubernetes would otherwise inject variables such as `POSTGRES_PORT=tcp://10.96.0.1:5432`
into the environment.

### Continuous integration

GitHub Actions runs on every pull request and every push to `main`:

| Job                             | Checks                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, types, unit tests | `npm ci`, Prettier, oxlint, `tsc`, Vitest, build                                                                                                                       |
| Integration and e2e tests       | The Testcontainers suite (PostgreSQL/PostGIS, Kafka, Redis)                                                                                                            |
| Commit messages                 | commitlint over the commits of the pull request                                                                                                                        |
| Docker image and Kubernetes     | Manifests validated against the Kubernetes and KEDA schemas; the image built and deployed to a kind cluster with KEDA; a smoke test: area, pings, entry in `GET /logs` |

The token is read-only, checkouts keep no credentials, pull request data reaches scripts through the environment, and
third-party actions are pinned to commits; Dependabot proposes updates. The repository has no remote yet: the
workflow was checked with actionlint (including shellcheck), and each job's steps were run locally (the checks job in a
clean Linux container, the Kubernetes steps on kind).

## Verified on a local kind cluster

Kubernetes 1.37, metrics-server 0.9.0, KEDA 2.21.0, the local overlay:

- Applying the overlay to an empty cluster: the jobs retried until PostgreSQL and Kafka were up, then completed; the
  API and the worker started before the database and connected when it came (attempt 4, after 11 s), with no restart.
- 300 pings/s for 4 minutes from k6 inside the cluster: p99 18.4 ms, every ping answered 202, none dropped. The HPA
  scaled the API from 1 to 3 pods after ~50 s and to 4 after ~140 s ("cpu resource utilization above target").
- Worker paused through KEDA, then released with a backlog: KEDA scaled the worker to 3 ("external metric
  s0-kafka-location-pings-v1 above target"). In a repeat with 19,000 pings waiting, one worker drained them in under
  7 s, before KEDA's next poll, and KEDA rightly kept one pod: lag-based scaling answers sustained backlogs, not
  short ones that one worker absorbs.
- The smoke test recorded an entry after one or two pings.

## Not included

- **Ingress / gateway, TLS and NetworkPolicies:** they depend on the platform (gateway product, CNI, monitoring
  namespace). Only the public API should be routed; `/health/*`, `/metrics` and `/docs` stay inside the cluster.
- **Prometheus Operator objects** (ServiceMonitor, alert rules): the pods carry the conventional scrape annotations.
- **Image signing, SBOM and vulnerability scanning** in CI, and a registry to push to.
- **PgBouncer:** at 30 API and 24 worker pods with 10 connections each, the connection count needs a pooler in
  front of PostgreSQL.

## Consequences

- One `kubectl apply -k` deploys the service; the autoscalers keep the replica counts, so manifests never set them.
- Every pull request deploys the service to a real Kubernetes API, so a broken manifest fails CI rather than a
  release.
- Rolling updates require backward-compatible migrations.
