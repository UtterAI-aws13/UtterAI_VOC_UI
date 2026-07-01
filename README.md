# UtterAI VOC UI

UtterAI 서비스군의 애플리케이션 레벨 모니터링 대시보드.  
OpenSearch(트레이스)와 Loki(로그)를 데이터 소스로 사용하며, 다른 레포 코드를 수정하지 않고 읽기 전용으로 동작한다.

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
