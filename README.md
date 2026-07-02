# UtterAI VOC UI

UtterAI 서비스군의 애플리케이션 레벨 모니터링 대시보드.  
OpenSearch(트레이스)와 Loki(로그)를 데이터 소스로 사용하며, 다른 레포 코드를 수정하지 않고 읽기 전용으로 동작한다.

## 인프라 모니터링과 이 UI는 무엇이 다른가

UtterAI 인프라(`UtterAI_Infra` 레포)에는 **kube-prometheus-stack(Prometheus + Grafana) 기반 모니터링이 이미 별도로 구축되어 있다.** 이 UI는 그것을 대체하지 않고, 관측 대상이 다른 별도 레이어로 병행 운영된다.

| | 인프라 레벨 모니터링 (`UtterAI_Infra`) | 앱 레벨 모니터링 (이 레포) |
|---|---|---|
| 스택 | Prometheus + Grafana, Alertmanager, Loki, Tempo, Kubecost | OpenSearch + Data Prepper, Loki(공용) |
| 보는 것 | node/pod CPU·메모리, Pod 상태(Pending/CrashLoop/OOMKilled), Karpenter 오토스케일링, 큐 적체, 비용 | 서비스 간 호출 관계(Service Map), 트레이스 하나의 전체 흐름(Gantt), 에러율/레이턴시, **어떤 유저의 요청에서 에러가 났는지** |
| 조회 단위 | 네임스페이스·Pod·노드 단위 시계열 | traceId·job_id·user.email 단위 개별 요청 |
| 접근 방식 | `kubectl port-forward`로 Grafana 접속, 대시보드에서 패널 확인 | 이 UI에서 Service Map 클릭 → 트레이스 → 로그로 드릴다운 |
| 알림 | Prometheus Alert → Alertmanager → Discord `#monitoring-alerts` (임계치 기반 자동 알림) | 알림 기능 없음. VOC(유저 문의) 접수 후 **사후 조사**용 조회 도구 |
| 트리거 시점 | 노드 부족, OOM, 큐 적체, 에러율 급증 등 인프라 이상 징후가 알림으로 먼저 옴 | "특정 유저 A가 O시경 분석이 실패했다고 신고" 같은 VOC가 접수된 뒤, 그 유저·시간대의 요청을 역추적할 때 |

**왜 두 레이어로 나눴나:** 원래는 Grafana의 Service Graph(Tempo 기반)로 서비스 토폴로지를 보려 했으나, `backend → SQS → cpu-worker → SQS → ml-gpu-worker`처럼 SQS로 끊어지는 비동기 구조에서는 CLIENT↔SERVER 스팬 페어링이 TTL 안에 매칭되지 않아 구조적으로 동작하지 않았다. 그래서 서비스 간 흐름·개별 요청 추적에 특화된 별도 스택(OpenSearch + Data Prepper)과 전용 UI를 만들었다. Tempo·Prometheus·Loki는 인프라 레벨 관측용으로 계속 유지되며, 이 UI와 데이터를 공유하는 것은 Loki(로그)뿐이다.

## 데이터가 만들어지는 과정 (인프라 관점)

이 UI는 아무것도 직접 수집하지 않는다. 모든 데이터는 각 서비스 Pod에 주입된 OpenTelemetry SDK에서 시작해서, 클러스터 내부 파이프라인을 거쳐 OpenSearch/Loki에 쌓인 것을 읽기 전용으로 조회할 뿐이다.

```
[backend / cpu-worker / ml-gpu-worker Pod]
  OTel SDK가 요청마다 스팬(작업 단위 기록)을 생성
      │ OTLP HTTP (:4318)
      ▼
[OTel Collector]  (utterai-observability 네임스페이스)
  하나의 스팬을 3갈래로 동시 전달 (앱 코드는 한 번만 계측하면 됨)
      ├─▶ Tempo            → Grafana에서 트레이스 조회 (인프라 레벨, 유지)
      ├─▶ spanmetrics      → Prometheus → Grafana 대시보드 (에러율/p50/p99)
      └─▶ Data Prepper     → OpenSearch  ← 이 UI가 읽는 경로
```

**Data Prepper가 하는 일:** OTel이 보내는 OTLP 형식은 OpenSearch가 바로 이해하지 못하므로, 중간에서 JSON으로 변환해 넣어준다. 이때 동일 trace의 스팬들을 **최대 180초 동안 버퍼에 모았다가** 한 번에 기록한다. 그래서 방금 발생한 요청이 이 UI에 뜨기까지 최대 3분 정도 지연될 수 있다 — 실시간 대시보드가 아니라 VOC 조사용 도구이기 때문에 감내 가능한 트레이드오프로 판단했다.

**서비스 간 화살표(Service Map)가 그려지는 조건:** backend가 SQS에 메시지를 발행(PRODUCER)하고 cpu-worker가 그 메시지를 수신(CONSUMER)할 때, 두 스팬이 같은 traceId를 공유하도록 SQS 메시지 속성에 트레이스 컨텍스트(`traceparent`)를 실어 보낸다. Data Prepper는 이 PRODUCER→CONSUMER 관계를 180초 슬라이딩 윈도우 안에서 감지했을 때만 Service Map에 엣지를 그린다. 즉 화면에 backend와 cpu-worker가 떠 있어도 그 사이 화살표가 안 보인다면, 최근 180초 내에 실제 호출이 없었거나 아직 버퍼링 중이라는 뜻이다.

**로그는 트레이스와 다른 경로로 온다:** 각 서비스는 `OTEL_LOGS_EXPORTER=none`으로 설정되어 있어 로그를 OTel로 보내지 않는다. 대신 Pod의 stdout/stderr를 Promtail이 수집해서 Loki(S3 backend)에 저장한다. 그래서 TraceDetail에서 "로그 보기"를 누르면 traceId가 아니라 **스팬의 서비스명 + 시간 범위(±1분)** 로 Loki를 역으로 조회하는 방식으로 연결된다.

## 실행

```bash
npm install
npm run dev
```

로컬에서 OpenSearch(9200)와 Loki(3100)에 포트 포워딩이 연결되어 있어야 한다.

```bash
# OpenSearch
kubectl port-forward svc/opensearch 9200:9200 -n utterai-observability

# Loki
kubectl port-forward svc/loki-gateway 3100:80 -n monitoring
```

## 화면 구성

### Service Map

서비스 간 호출 관계를 그래프로 표시한다. 노드 색상은 에러율을 나타낸다.

| 색상 | 의미 |
|------|------|
| 초록 | 에러 없음 |
| 주황 | 에러율 0% 초과 |
| 빨강 | 에러율 10% 초과 |

노드를 클릭하면 해당 서비스의 최근 트레이스 목록이 우측 패널에 표시된다.

### 트레이스 목록 (TraceList)

서비스 노드를 클릭하면 열린다. 최근 20건의 트레이스를 표시하며, 에러가 있는 행은 붉게 강조된다.

**검색 모드**

상단 드롭다운에서 검색 기준을 선택한 뒤 Enter(또는 검색 버튼)를 누른다.

| 모드 | 검색 대상 | 용도 |
|------|----------|------|
| `job_id` | `attributes.job.id` | 특정 분석 job의 전체 파이프라인 트레이스 조회 |
| `user.email` | `attributes.user.email` | 특정 유저가 발생시킨 모든 트레이스 조회 |

두 모드 모두 serviceName 필터 없이 전체 서비스 대상으로 검색한다.

### 트레이스 상세 (TraceDetail)

트레이스 행을 클릭하면 전체 화면으로 전환되어 Gantt 차트를 표시한다.

- 각 스팬을 클릭하면 하단에 상세 정보(Span ID, 서비스, kind, status, attributes)가 표시된다.
- 스팬에 `user.id` / `user.email` attribute가 있으면 상단에 **USER 배지**로 강조 표시된다.
- 스팬 선택 후 **로그 보기 →** 버튼을 클릭하면 해당 서비스·시간대의 로그로 자동 이동한다.

### 에러 통계 (ErrorStats)

서비스별 총 요청수, 에러수, 에러율, p50/p99 레이턴시를 표시한다. 시간 범위는 15분 / 1시간 / 6시간 / 24시간으로 전환 가능하며 30초마다 자동 갱신된다.

### Pod Logs

Loki에서 로그를 조회한다. 네임스페이스 → 파드 → 컨테이너 순으로 범위를 좁힐 수 있다.

- 로그 레벨(ERROR / WARN / DEBUG / INFO)에 따라 색상이 구분된다.
- 텍스트 필터로 클라이언트 측 필터링이 가능하다.
- 10초 자동 새로고침 옵션이 있다.

**드릴다운 모드**

TraceDetail에서 로그 보기로 진입하면 상단에 드릴다운 배너가 표시된다. 해당 스팬의 시간 범위(±1분 버퍼)로 Loki를 절대 시간 조회하며, 서비스명에 맞는 네임스페이스가 자동 선택된다.

| OTel serviceName | Loki namespace |
|---|---|
| `backend` | `utterai-api` |
| `cpu-worker` | `utterai-ai-cpu` |
| `ml-gpu-worker` | `utterai-ai-gpu` |
| `batch-worker` | `utterai-batch` |
| `ai-service` | `utterai-ai-service` |

## 주요 사용 시나리오

**1. 서비스 에러 파악**

에러 통계 탭 → 에러율이 높은 서비스 확인 → Service Map에서 해당 노드 클릭 → 에러 트레이스 선택 → 어느 스팬에서 실패했는지 확인

**2. 특정 요청 추적 (job_id 기반)**

트레이스 목록 검색창에서 `job_id` 모드 선택 → job_id 입력 → TraceDetail에서 전체 파이프라인(backend → cpu-worker → ml-gpu-worker) 스팬 확인

**3. 에러 발생 유저 특정**

트레이스 목록 검색창에서 `user.email` 모드 선택 → 이메일 입력 → 해당 유저의 요청 트레이스 조회 → 에러가 있는 트레이스 선택 → TraceDetail 스팬 상단의 USER 배지로 유저 확인

**4. 에러 스팬 → 로그 드릴다운**

TraceDetail에서 에러 스팬 클릭 → 로그 보기 → 해당 시점의 파드 로그 확인

## 데이터 소스

| 소스 | 프록시 경로 | 용도 |
|------|------------|------|
| OpenSearch `:9200` | `/opensearch` | 트레이스 스팬, 서비스맵, 에러 통계 |
| Loki `:3100` | `/loki` | 파드 컨테이너 로그 |

Vite 개발 서버와 nginx(프로덕션) 모두 동일한 경로로 프록시한다.

## 상세 문서

인프라 연동 구조, OTel 파이프라인, OpenSearch 인덱스 스키마, 컴포넌트별 상태 흐름 등 기술 상세는 [ARCHITECTURE.md](./ARCHITECTURE.md)를 참고한다.
