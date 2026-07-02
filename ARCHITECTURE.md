# UtterAI VOC UI — 아키텍처 및 기술 문서

## 1. 시스템 개요

이 프로젝트는 UtterAI 서비스군(별도 레포)에서 발생하는 이벤트를 **읽기 전용**으로 시각화하는 모니터링 UI다.
다른 레포의 코드를 직접 수정하지 않고, 해당 서비스들이 공통 인프라(OpenSearch, Loki)에 쌓는 데이터를 조회한다.

```
[ UtterAI 서비스들 ]
  backend / cpu-worker / ml-gpu-worker
        │                │
   OTel Collector    Promtail / Loki agent
        │                │
  [ OpenSearch ]    [ Loki ]
  otel-v1-apm-*        │
  otel-v1-apm-        │
  service-map         │
        │              │
        └──────┬───────┘
               │  (HTTP, Vite proxy)
        [ UtterAI VOC UI ]  ← 이 레포
```

### 데이터 소스

| 소스 | 포트 | 용도 |
|------|------|------|
| OpenSearch | 9200 | 분산 트레이스 스팬, 서비스맵, 에러 통계 |
| Loki | 3100 | 파드 컨테이너 로그 |

두 소스 모두 Vite 개발 서버의 프록시를 통해 CORS 없이 접근한다 (`vite.config.ts`).

### 핵심 컴포넌트란?

| 컴포넌트 | 무엇인가 | 이 프로젝트에서의 역할 |
|---|---|---|
| **OpenSearch** | Elasticsearch 7.10을 포크해 시작된 오픈소스 검색·분석 엔진. Lucene 기반 역인덱스(inverted index)로 모든 필드를 색인해두기 때문에 필드별 필터·정렬·집계(aggregation)가 빠르다 | 트레이스 스팬, 서비스맵 호출 관계, 에러 통계를 저장·검색하는 1차 데이터 스토어. `fetchServiceMap`, `fetchRecentTraces`, `fetchTraceSpans`, `fetchErrorStats`가 모두 이 인덱스를 조회 |
| **Data Prepper** | OpenSearch 프로젝트 산하의 서버사이드 데이터 수집·가공기. Logstash와 비슷한 포지션으로, OTLP로 들어온 원시 텔레메트리를 파이프라인 단위로 필터링·변환해 OpenSearch가 색인할 수 있는 문서 형태로 만든다 | OTel Collector와 OpenSearch 사이의 "변환기". `raw-trace-pipeline`이 스팬을 `otel-v1-apm-span-{date}`로, `service-map-pipeline`이 180초 슬라이딩 윈도우로 호출 관계를 집계해 `otel-v1-apm-service-map`으로 적재한다 (자세한 파이프라인 구조는 섹션 11-3 참고) |
| **Loki** | Grafana Loki. OpenSearch와 달리 로그 **본문은 색인하지 않고** `namespace`/`pod`/`container` 같은 **레이블만 색인**한다. 쿼리 시 레이블로 스트림을 먼저 좁힌 뒤 본문은 grep 방식으로 순차 스캔 — 그만큼 저장 비용이 낮아 대량 로그에 적합하다 | 파드 stdout/stderr 로그 저장소. PodLogs 탭이 조회하는 유일한 소스 (`fetchNamespaces`/`fetchPods`/`fetchContainers`/`fetchLogs`) |

**OpenSearch와 Loki를 함께 쓰는 이유:**
- 트레이스/스팬은 필드가 많고(서비스명, 상태코드, duration 등) 필드별 집계·정렬이 필요하다 → 역인덱스 기반 OpenSearch가 유리
- 로그는 텍스트 그 자체가 데이터이고 유입량이 훨씬 많다 → 전체 텍스트를 색인하는 OpenSearch보다, 레이블만 색인하는 Loki가 훨씬 저비용

---

## 2. 데이터 흐름 전체도

```
OpenSearch
  otel-v1-apm-service-map   →  fetchServiceMap()   →  ServiceMap (Cytoscape 그래프)
  otel-v1-apm-span-*        →  fetchRecentTraces() →  TraceList (테이블)
  otel-v1-apm-span-*        →  fetchTraceSpans()   →  TraceDetail (Gantt)
  otel-v1-apm-span-*        →  fetchErrorStats()   →  ErrorStats (테이블)

Loki
  /api/v1/label/namespace/values  →  fetchNamespaces()  →  PodLogs (네임스페이스 셀렉터)
  /api/v1/label/pod/values        →  fetchPods()        →  PodLogs (파드 셀렉터)
  /api/v1/label/container/values  →  fetchContainers()  →  PodLogs (컨테이너 셀렉터)
  /api/v1/query_range             →  fetchLogs()        →  PodLogs (로그 뷰어)
```

---

## 3. API 레이어 (`src/api/`)

### 3-1. `opensearch.ts`

모든 요청은 `query()` 헬퍼를 통해 `POST /opensearch/{index}/_search` 로 전송된다.

#### 공통 헬퍼

```ts
async function query(index: string, body: unknown): Promise<any>
```

- `index`: 조회할 OpenSearch 인덱스 이름
- `body`: Elasticsearch DSL 쿼리 객체 (JSON)
- 응답이 `!ok`이면 즉시 throw

---

#### `fetchServiceMap() → ServiceMapEdge[]`

**인덱스:** `otel-v1-apm-service-map`

**쿼리:**
```json
{ "size": 200, "query": { "match_all": {} } }
```

**응답 → 변환:**

| OpenSearch 필드 | 변환 결과 | 설명 |
|----------------|-----------|------|
| `_source.serviceName` | `edge.source` | 호출한 서비스 |
| `_source.destination.domain` | `edge.target` | 호출받은 서비스 |
| `_source.destination.resource` | `edge.resource` | 호출된 리소스 경로 |
| `_source.traceGroupName` | `edge.traceGroupName` | 트레이스 그룹명 |

`destination.domain`이 없는 레코드는 건너뜀 (외부 도메인 등 불완전 레코드 제거).

**타입:**
```ts
interface ServiceMapEdge {
  source: string;       // 예: "backend"
  target: string;       // 예: "cpu-worker"
  resource: string;     // 예: "/api/v1/process"
  traceGroupName: string;
}
```

---

#### `fetchRecentTraces(serviceName, limit=20, jobId?, userEmail?) → TraceRow[]`

**인덱스:** `otel-v1-apm-span-*` (와일드카드 — 날짜별 롤링 인덱스)

**쿼리 분기:**

| 파라미터 | ES 쿼리 | 설명 |
|---------|---------|------|
| 기본 (없음) | `serviceName` + `kind=SERVER\|CONSUMER` | 해당 서비스 진입점 스팬 최신 N건 |
| `jobId` 있음 | `term: attributes.job\.id = jobId` | serviceName 무관, 해당 job의 전 서비스 스팬 |
| `userEmail` 있음 | `term: attributes.user\.email = userEmail` | 해당 유저가 발생시킨 전 서비스 스팬 |

`jobId`, `userEmail` 모두 있으면 `jobId` 우선.

**변환:**

| OpenSearch 필드 | 변환 결과 | 설명 |
|----------------|-----------|------|
| `traceId` | `traceId` | 트레이스 식별자 |
| `name` | `rootName` | 진입점 오퍼레이션명 |
| `startTime` | `startTime` | ISO 8601 문자열 |
| `durationInNanos` | `durationMs` | `/ 1_000_000` 후 반올림 |
| `status === 'STATUS_CODE_ERROR'` | `hasError` | 에러 여부 |

**타입:**
```ts
interface TraceRow {
  traceId: string;
  rootName: string;
  startTime: string;
  durationMs: number;
  hasError?: boolean;
}
```

---

#### `fetchTraceSpans(traceId) → Span[]`

**인덱스:** `otel-v1-apm-span-*`

**쿼리 조건:** `traceId` 정확 일치, 최대 500개, 시작시간 오름차순

**타입:**
```ts
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;    // 루트 스팬은 빈 문자열
  serviceName: string;
  name: string;            // 오퍼레이션명
  kind: string;            // SPAN_KIND_SERVER | SPAN_KIND_CLIENT | ...
  status: string;          // STATUS_CODE_OK | STATUS_CODE_ERROR | ...
  startTime: string;       // ISO 8601
  durationInNanos: number;
  attributes?: Record<string, unknown>;  // HTTP method, URL 등 임의 속성
}
```

---

#### `fetchErrorStats(rangeMinutes) → ServiceStat[]`

**인덱스:** `otel-v1-apm-span-*`

**집계 파이프라인:**
```
by_service (terms, field: serviceName.keyword, size: 20)
  └── error_count (filter: status == STATUS_CODE_ERROR)
  └── p50 (percentiles: durationInNanos, [50])
  └── p99 (percentiles: durationInNanos, [99])
```

**시간 필터:** `startTime >= now - {rangeMinutes}m`

**변환:**

| 집계 결과 | 변환 결과 | 계산 방식 |
|----------|-----------|-----------|
| `bucket.doc_count` | `total` | 직접 |
| `error_count.doc_count` | `errors` | 직접 |
| `errors / total * 100` | `errorRate` | 소수점 1자리 |
| `p50.values['50.0']` | `p50Ms` | `/ 1_000_000` 후 반올림 |
| `p99.values['99.0']` | `p99Ms` | `/ 1_000_000` 후 반올림 |

**타입:**
```ts
interface ServiceStat {
  service: string;
  total: number;
  errors: number;
  errorRate: number;  // 0~100
  p50Ms: number;
  p99Ms: number;
}
```

---

### 3-2. `loki.ts`

모든 요청은 `lokiGet()` 헬퍼를 통해 `GET /loki{path}?{qs}` 로 전송된다.

#### 공통 헬퍼

```ts
async function lokiGet(path: string, params: Record<string, string>): Promise<any>
```

빈 문자열 파라미터는 자동으로 제거된다 (`Object.entries(...).filter(([, v]) => v !== '')`).

---

#### `fetchNamespaces() → string[]`

Loki 레이블 API로 `namespace` 레이블의 모든 값을 가져온 뒤 `utterai-` 접두사가 있는 것만 반환.

→ 이 필터가 모니터링 범위를 **UtterAI 서비스군으로만** 제한하는 경계선이다.

---

#### `fetchPods(namespace) → string[]`

`{namespace="{namespace}"}` 셀렉터로 해당 네임스페이스의 파드 목록 반환.
PodLogs에서 네임스페이스가 변경될 때마다 호출된다.

---

#### `fetchContainers(namespace, pod) → string[]`

`{namespace="{namespace}", pod="{pod}"}` 셀렉터로 특정 파드의 컨테이너 목록 반환.
파드가 선택될 때마다 호출된다.

---

#### `fetchLogs(opts) → LogEntry[]`

가장 복잡한 API 함수. 옵션 구조:

```ts
{
  namespace: string;   // 필수 — Loki 스트림 셀렉터
  pod: string;         // 빈 문자열이면 전체 파드
  container: string;   // 빈 문자열이면 전체 컨테이너
  range: string;       // '15m' | '1h' | '3h' | '24h' — 상대 시간 범위
  limit?: number;      // 기본 300
  absoluteRange?: {    // 드릴다운 시 사용 — 상대 range 무시
    startSec: number;
    endSec: number;
  };
}
```

**시간 범위 결정 로직:**

```ts
if (absoluteRange) {
  // 트레이스 드릴다운: span.startTime ± 버퍼로 정해진 절대 범위
  startSec = absoluteRange.startSec;
  endSec   = absoluteRange.endSec;
} else {
  // 일반 모드: 현재 시각 기준 상대 범위
  startSec = Date.now() / 1000 - RANGE_SECONDS[range];
  endSec   = Date.now() / 1000;
}
```

**Loki 스트림 셀렉터 조합:**
```
{namespace="utterai-backend"}                        // namespace만
{namespace="utterai-backend", pod="backend-abc-123"} // +pod
{namespace="utterai-backend", pod="...", container="app"} // +container
```

**반환 타입:**
```ts
interface LogEntry {
  tsNs: string;                     // 나노초 단위 Unix 타임스탬프 (문자열)
  line: string;                     // 로그 한 줄
  stream: Record<string, string>;   // Loki 스트림 레이블 전체 (pod, container 등 포함)
}
```

응답 파싱 후 `tsNs` 기준 내림차순 정렬 (최신 로그가 위).

---

## 4. 컴포넌트 구조 및 상태 흐름

### 4-1. `App.tsx` — 전역 상태 허브

```ts
// 탭 네비게이션
tab: 'map' | 'stats' | 'logs'

// Service Map 탭용 데이터 (앱 마운트 시 로드)
edges: ServiceMapEdge[]    // 서비스 간 호출 관계
stats: ServiceStat[]       // 서비스별 에러율/레이턴시 (최근 1시간)

// 드릴다운 탐색 상태 (서로 연결된 단방향 흐름)
selectedService: string | null   // 서비스맵 노드 클릭 → TraceList 표시
selectedTrace: string | null     // TraceList 행 클릭 → TraceDetail 전체화면
drilldown: DrilldownContext | null  // TraceDetail "로그 보기" → PodLogs 드릴다운
```

**상태 전이 다이어그램:**

```
[초기]
  tab='map', selectedService=null, selectedTrace=null, drilldown=null

[서비스맵 노드 클릭]
  selectedService = "backend"
  → TraceList가 우측 패널에 표시됨

[TraceList 행 클릭]
  selectedTrace = "abc123..."
  → 전체 화면이 TraceDetail로 교체됨 (조기 return)

[TraceDetail "로그 보기" 클릭]
  drilldown = { serviceName: "backend", startMs: ..., endMs: ... }
  tab = 'logs'
  selectedTrace = null
  → TraceDetail 해제, PodLogs 탭으로 이동

[Pod Logs 탭 직접 클릭]
  tab = 'logs'
  drilldown = null
  → 드릴다운 없는 일반 PodLogs
```

---

### 4-2. `ServiceMap.tsx`

**라이브러리:** Cytoscape.js

**입력 props:**

| prop | 타입 | 역할 |
|------|------|------|
| `edges` | `ServiceMapEdge[]` | 노드/엣지 데이터 원본 |
| `stats` | `ServiceStat[]` | 노드 색상 결정용 에러율 |
| `onNodeClick` | `(name: string) => void` | 클릭 이벤트 → App의 `selectedService` 갱신 |

**노드 색상 결정:**
```ts
errorRate > 10%  → '#f44336'  (빨강)
errorRate > 0%   → '#FF9800'  (주황)
errorRate === 0  → '#4CAF50'  (초록)
데이터 없음       → '#4CAF50'  (초록)
```

**엣지 레이블 처리 (`edgeLabel`):**

`traceGroupName` 또는 `resource`에서 경로 변수 `{id}` → `*` 치환 후 마지막 경로 세그먼트만 표시.
예) `GET /api/v1/users/{userId}/tasks` → `tasks`

**주의:** `edges`나 `stats`가 바뀔 때마다 Cytoscape 인스턴스를 destroy 후 재생성한다. 이는 Cytoscape가 React 렌더링 외부에서 DOM을 직접 조작하기 때문이다.

---

### 4-3. `TraceList.tsx`

`serviceName` prop이 바뀔 때 `fetchRecentTraces()` 재호출.
에러가 있는 행은 별도 CSS 클래스(`errorRow`)로 강조.

**검색 모드 (`searchMode`):**

```ts
'job_id'    → fetchRecentTraces(serviceName, 20, trimmed, undefined)
'user.email' → fetchRecentTraces(serviceName, 20, undefined, trimmed)
```

드롭다운으로 모드를 전환하며, `serviceName` 이 변경되면 검색 상태(`activeSearch`)가 초기화된다.

**이벤트:** 행 클릭 → `onSelectTrace(traceId)` → App의 `selectedTrace` 갱신

---

### 4-4. `TraceDetail.tsx`

`traceId` prop이 바뀔 때 `fetchTraceSpans()` 재호출. 스팬을 `startTime` 오름차순으로 정렬 후 Gantt 차트로 렌더링.

**Gantt 위치/너비 계산:**

```ts
t0       = spans[0].startTime (밀리초)
totalMs  = max(span.startTime + span.duration) - t0  // 전체 트레이스 시간폭
left     = (span.startTime - t0) / totalMs * 100     // % 단위 X 위치
width    = max(span.duration / totalMs * 100, 0.3)   // 최소 0.3% (너무 짧은 스팬도 보임)
```

**선택된 스팬 상세:**

`selected: Span | null` 로컬 상태. 같은 스팬을 다시 클릭하면 토글 해제.

**USER 배지:**

선택된 스팬의 `attributes['user.id']` 또는 `attributes['user.email']`이 존재하면 상세 패널 최상단에 파란 배지로 표시. 나머지 attributes에서 두 키는 제외하여 JSON 덤프에 중복 노출되지 않는다.

```ts
const userId    = selected.attributes?.['user.id'];
const userEmail = selected.attributes?.['user.email'];
const otherAttrs = Object.fromEntries(
  Object.entries(attributes).filter(([k]) => k !== 'user.id' && k !== 'user.email')
);
```

**"로그 보기" 버튼:**

`onViewLogs` prop이 주어졌을 때만 렌더링. 클릭 시:
```ts
startMs = span.startTime - 60_000        // 스팬 시작 1분 전
endMs   = span.startTime + span.durationMs + 60_000  // 스팬 종료 1분 후
onViewLogs({ serviceName: span.serviceName, startMs, endMs })
```

→ App에서 `drilldown` 상태에 저장 후 PodLogs로 전달.

**props:**

| prop | 타입 | 역할 |
|------|------|------|
| `traceId` | `string` | 조회할 트레이스 ID |
| `onBack` | `() => void` | 뒤로가기 → `selectedTrace = null` |
| `onViewLogs` | `(ViewLogsInfo) => void \| undefined` | 드릴다운 시작 |

---

### 4-5. `ErrorStats.tsx`

독립적인 자체 데이터 로딩 컴포넌트. App으로부터 props를 받지 않는다.

**로컬 상태:**

```ts
range: number         // 분 단위 (15 | 60 | 360 | 1440)
stats: ServiceStat[]
loading: boolean
lastUpdated: Date | null
```

**자동 갱신:** 30초마다 `fetchErrorStats(range)` 재호출. `range` 변경 시 인터벌 재설정.

**에러율 색상:**
```ts
errorRate > 10  → '#f44336'
errorRate > 0   → '#FF9800'
errorRate === 0 → '#4CAF50'
```

---

### 4-6. `PodLogs.tsx`

가장 복잡한 컴포넌트. 계단식 셀렉터(namespace → pod → container)와 드릴다운 모드를 동시에 처리.

**로컬 상태:**

```ts
namespaces: string[]    // Loki에서 가져온 utterai-* 목록
pods: string[]          // 선택된 namespace의 파드 목록
containers: string[]    // 선택된 pod의 컨테이너 목록

namespace: string       // 현재 선택된 네임스페이스
pod: string             // '' = 전체
container: string       // '' = 전체
range: Range            // '15m' | '1h' | '3h' | '24h'
filter: string          // 클라이언트 측 텍스트 필터

entries: LogEntry[]
loading: boolean
autoRefresh: boolean    // 10초마다 자동 새로고침
```

**계단식 의존성 useEffect:**

```
[마운트]         → fetchNamespaces() → namespaces 세팅 (drilldown 있으면 utterai-{svc} 우선)
[namespace 변경] → fetchPods()       → pods 세팅, pod/container 초기화
[pod 변경]       → fetchContainers() → containers 세팅, container 초기화
[어떤 상태든 변경] → doFetch() (debounce 200ms)
```

**`doFetch` 의존 상태 목록:**
```ts
useCallback([namespace, pod, container, range, drilldown])
```

`drilldown`이 바뀌면(트레이스에서 넘어올 때) 자동으로 새로운 절대 시간 범위로 재조회.

**드릴다운 모드 동작:**

1. 마운트 시 `utterai-{drilldown.serviceName}` 네임스페이스 자동 선택
2. `fetchLogs`에 `absoluteRange` 전달 → Loki가 정확한 시간 구간 조회
3. 상단에 드릴다운 배너 표시: `서비스명 · 시작시간 ~ 종료시간 [해제]`
4. "해제" 클릭 → `onClearDrilldown()` → App에서 `drilldown = null`

**클라이언트 측 필터:**

`entries`는 전체 로그. `displayed = filter ? entries.filter(...) : entries`로 필터링.
필터 카운트 `displayed.length / entries.length` 표시.

**로그 레벨 감지 (`detectLevel`):**

```ts
/ERROR|CRITICAL|FATAL|EXCEPTION/ → 'error'
/WARN|WARNING/                   → 'warn'
/DEBUG|TRACE/                    → 'debug'
기타                              → 'info'
```

로그 라인 전체 텍스트를 대문자로 변환 후 정규식 매칭.

**타임스탬프 포맷 (`formatTs`):**

Loki가 반환하는 `tsNs`는 나노초 단위 Unix 타임스탬프 **문자열**. 앞 13자리가 밀리초.
```ts
const ms = parseInt(tsNs.slice(0, 13), 10);
// → "HH:MM:SS.mmm" 형식
```

**props:**

| prop | 타입 | 역할 |
|------|------|------|
| `drilldown` | `DrilldownContext \| undefined` | 트레이스에서 넘어온 컨텍스트 |
| `onClearDrilldown` | `() => void \| undefined` | "해제" 버튼 핸들러 |

---

## 5. 드릴다운 전체 데이터 흐름 (핵심 기능)

```
사용자: ServiceMap에서 "backend" 노드 클릭
  ↓
App: selectedService = "backend"
  ↓
TraceList: fetchRecentTraces("backend")
  OpenSearch 쿼리:
    index: otel-v1-apm-span-*
    filter: serviceName="backend", kind=SERVER or CONSUMER
    sort: startTime desc, limit: 20
  ↓
사용자: 에러가 있는 트레이스 행 클릭
  ↓
App: selectedTrace = "a1b2c3d4..."
  → 전체 화면을 TraceDetail로 교체
  ↓
TraceDetail: fetchTraceSpans("a1b2c3d4...")
  OpenSearch 쿼리:
    index: otel-v1-apm-span-*
    filter: traceId="a1b2c3d4..."
    sort: startTime asc, limit: 500
  → Gantt 차트 렌더링
  ↓
사용자: 에러 스팬 "POST /process" (backend, startTime=T, duration=2300ms) 클릭
  ↓
TraceDetail: selected = 해당 Span 객체
  → 하단 상세 패널에 "로그 보기 →" 버튼 표시
  ↓
사용자: "로그 보기 →" 클릭
  ↓
TraceDetail → onViewLogs({
  serviceName: "backend",
  startMs: T - 60_000,      // 스팬 시작 1분 전
  endMs:   T + 2300 + 60_000  // 스팬 종료 1분 후
})
  ↓
App:
  drilldown = { serviceName: "backend", startMs, endMs }
  tab = 'logs'
  selectedTrace = null
  ↓
PodLogs (마운트):
  fetchNamespaces() → ["utterai-backend", "utterai-worker", ...]
  → "utterai-backend" 자동 선택 (drilldown.serviceName 매핑)
  ↓
PodLogs: doFetch()
  fetchLogs({
    namespace: "utterai-backend",
    pod: "", container: "",
    range: "15m",  // 상대 범위 (무시됨)
    absoluteRange: {
      startSec: (T - 60_000) / 1000,
      endSec:   (T + 2300 + 60_000) / 1000
    }
  })
  ↓
  Loki 쿼리:
    selector: {namespace="utterai-backend"}
    start: (T-60s), end: (T+62.3s)
    limit: 300, direction: backward
  ↓
  결과: 해당 스팬 발생 구간의 backend 로그 (최신순)
  ↓
  상단 배너: "트레이스 드릴다운 — backend · HH:MM:SS ~ HH:MM:SS [해제]"
```

---

## 6. OpenSearch 인덱스 구조 (참고)

### `otel-v1-apm-service-map`

OpenTelemetry Collector의 서비스맵 프로세서가 기록하는 서비스 간 호출 관계 인덱스.

| 필드 | 타입 | 설명 |
|------|------|------|
| `serviceName` | keyword | 호출한 서비스명 |
| `destination.domain` | keyword | 호출받은 서비스/도메인 |
| `destination.resource` | keyword | 호출된 리소스 경로 |
| `traceGroupName` | keyword | 트레이스 그룹 이름 |

### `otel-v1-apm-span-{date}` (롤링 인덱스)

OTel 스팬 데이터. `otel-v1-apm-span-*`로 와일드카드 조회.

| 필드 | 타입 | 설명 |
|------|------|------|
| `traceId` | keyword | 트레이스 ID (hex) |
| `spanId` | keyword | 스팬 ID |
| `parentSpanId` | keyword | 부모 스팬 ID (루트는 빈 문자열) |
| `serviceName` | keyword | 서비스명 |
| `name` | keyword | 오퍼레이션명 |
| `kind` | keyword | `SPAN_KIND_SERVER`, `SPAN_KIND_CLIENT`, `SPAN_KIND_CONSUMER` 등 |
| `status` | keyword | `STATUS_CODE_OK`, `STATUS_CODE_ERROR`, `STATUS_CODE_UNSET` |
| `startTime` | date | ISO 8601 |
| `durationInNanos` | long | 나노초 단위 지속 시간 |
| `attributes` | object | HTTP method/URL, DB 쿼리 등 임의 속성 |

**진입점 스팬 필터 (`kind = SERVER or CONSUMER`):**
- `SERVER`: HTTP 요청을 받는 서버 스팬 (REST API)
- `CONSUMER`: 메시지 큐 컨슈머 스팬 (Kafka 등)
- `CLIENT`: 외부 호출 스팬 — TraceList에서 제외 (중복 집계 방지)

---

## 7. Vite 프록시 설정

```ts
// vite.config.ts
server: {
  proxy: {
    '/opensearch': {
      target: 'http://localhost:9200',
      rewrite: (path) => path.replace(/^\/opensearch/, ''),
      changeOrigin: true,
    },
    // /loki → http://localhost:3100 (미설정 시 추가 필요)
  }
}
```

> **주의:** Loki 프록시는 현재 `vite.config.ts`에 없다. `src/api/loki.ts`의 `BASE = '/loki'`가 작동하려면 `/loki` 프록시 항목도 추가해야 한다.

---

## 8. 서비스명 → 네임스페이스 매핑 규칙

드릴다운에서 OpenSearch의 `serviceName`을 Loki의 `namespace`로 연결하는 명시적 매핑이 `PodLogs.tsx`에 정의되어 있다. `utterai-{serviceName}` 단순 치환은 실제 K8s 네임스페이스와 일치하지 않으므로 사용하지 않는다.

```ts
// src/components/PodLogs.tsx
const SERVICE_TO_NAMESPACE: Record<string, string> = {
  'backend':       'utterai-api',
  'cpu-worker':    'utterai-ai-cpu',
  'ml-gpu-worker': 'utterai-ai-gpu',
  'batch-worker':  'utterai-batch',
  'ai-service':    'utterai-ai-service',
};
```

| OTel `serviceName` | K8s namespace (Loki) |
|---|---|
| `backend` | `utterai-api` |
| `cpu-worker` | `utterai-ai-cpu` |
| `ml-gpu-worker` | `utterai-ai-gpu` |
| `batch-worker` | `utterai-batch` |
| `ai-service` | `utterai-ai-service` |

매핑에 없는 서비스명은 `utterai-{serviceName}` 폴백 후, 그것도 없으면 Loki 목록의 첫 번째 네임스페이스.

---

## 9. 컴포넌트 의존성 트리

```
App
├── ServiceMap          (props: edges, stats, onNodeClick)
├── TraceList           (props: serviceName, onSelectTrace)
├── TraceDetail *       (props: traceId, onBack, onViewLogs)
├── ErrorStats          (자체 데이터 로딩, props 없음)
└── PodLogs             (props: drilldown?, onClearDrilldown?)

* selectedTrace 있을 때 전체 화면 대체 렌더링
```

---

## 10. 향후 확장 시 고려사항

- **serviceName → namespace 매핑 수정** — 아래 섹션 11 참조. 드릴다운이 잘못된 네임스페이스로 이동하는 버그 존재
- **ServiceMap 실시간 갱신** — 현재 앱 마운트 시 1회만 로드. ErrorStats처럼 인터벌 추가 가능
- **절대 시간 범위 UI** — PodLogs의 드릴다운 모드는 range 셀렉터가 무시됨. UI에서 명시적으로 비활성화하거나 절대 시간 범위를 표시하면 더 직관적
- **TraceDetail parent/child 들여쓰기** — 현재 Gantt는 단순 시간축. `parentSpanId`를 활용한 트리 들여쓰기로 호출 계층 표현 가능

---

## 11. EKS 인프라 구조 (UtterAI_Infra 레포 기반)

### 11-1. 전체 클러스터 구조

```
VPC (10.0.0.0/16)  |  ap-northeast-2
│
├── Public Subnet   → ALB (internet-facing) / NAT Gateway
│
└── Private App Subnet → EKS Worker Nodes
    ├── Managed Node Group: system (t3/t3a medium~large, On-Demand)
    │   └── CoreDNS, kube-proxy, VPC CNI, LBC, Karpenter, KEDA, metrics-server, NVIDIA Device Plugin
    │
    └── Karpenter NodePools (동적 프로비저닝)
        ├── platform   (t3/t3a medium~large, On-Demand)  ← OpenSearch, Data Prepper 등 플랫폼 파드
        ├── api        (t3 medium, On-Demand+Spot)        ← utterai-api 네임스페이스
        ├── cpu-worker (m5/m5a/m6i/m6a xlarge, Spot우선) ← utterai-ai-cpu 네임스페이스
        ├── batch-worker (c5/c6i/c6a/m5/m6i large~xlarge, Spot우선) ← utterai-batch 네임스페이스
        └── gpu        (g4dn/g5 xlarge~2xlarge, Spot우선) ← utterai-ai-gpu 네임스페이스
```

**Karpenter + KEDA 연동 흐름:**
```
SQS 메시지 수 증가
  ↓
KEDA ScaledObject가 queueLength 기준으로 Worker Deployment replica 증가
  ↓
Pod Pending (기존 노드에 자원 없음)
  ↓
Karpenter가 Pending Pod의 nodeSelector/toleration/resource request 분석
  ↓
해당 NodePool의 EC2 인스턴스 자동 생성 (수십 초 내)
  ↓
Pod 배치 → SQS 메시지 처리
  ↓
메시지 소진 → KEDA scale-in → Karpenter consolidation → 노드 삭제
```

---

### 11-2. Kubernetes 네임스페이스 전체 목록

| 네임스페이스 | 워크로드 | NodePool |
|---|---|---|
| `utterai-api` | backend API (FastAPI) | api |
| `utterai-ai-service` | AI 서비스 (HPA 관리) | api |
| `utterai-ai-cpu` | cpu-worker (전처리, VAD, RAG 보조) | cpu-worker |
| `utterai-ai-gpu` | ml-gpu-worker (화자 분리, ASR 추론) | gpu |
| `utterai-batch` | batch-worker (RAG ingest, 리포트 생성) | batch-worker |
| `utterai-observability` | OTel Collector, OpenSearch, Data Prepper, Grafana 등 | platform |
| `monitoring` | kube-prometheus-stack, Loki, Tempo | (별도) |

---

### 11-3. OTel 텔레메트리 파이프라인 전체 경로

각 서비스 파드는 환경변수로 OTel 설정을 주입받는다.

```
# backend (utterai-api 네임스페이스)
OTEL_SERVICE_NAME=backend
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.utterai-observability.svc.cluster.local:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=none   ← 로그는 OTel로 보내지 않음 (Promtail이 stdout 수집)
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev,team=utterai

# cpu-worker (utterai-ai-cpu 네임스페이스)
OTEL_SERVICE_NAME=cpu-worker

# ml-gpu-worker (utterai-ai-gpu 네임스페이스)
OTEL_SERVICE_NAME=ml-gpu-worker
```

**OTel Collector 내부 파이프라인:**

```
서비스 파드 (OTLP HTTP :4318)
    │
    ▼
OTel Collector (utterai-observability/otel-collector)
    │
    ├── processors:
    │   ├── memory_limiter (256MiB 상한)
    │   ├── attributes/redact (Authorization, Cookie, URL, S3 key 등 민감정보 삭제)
    │   └── batch
    │
    ├── [traces 파이프라인]
    │   ├── → otlp/tempo  (tempo.monitoring.svc.cluster.local:4317)  ← 장기 저장/Grafana 조회
    │   ├── → spanmetrics connector  (pipeline.* 메트릭 생성)
    │   ├── → servicegraph connector (서비스 간 레이턴시 히스토그램 생성)
    │   └── → otlp/data-prepper  (data-prepper.utterai-observability.svc.cluster.local:21890)
    │                                ↓
    │             Data Prepper (OTLP gRPC :21890)
    │                 ├── raw-trace-pipeline
    │                 │   └── otel_trace_raw 프로세서 → OpenSearch otel-v1-apm-span-{date}
    │                 └── service-map-pipeline
    │                     └── service_map 프로세서 (180초 윈도우) → OpenSearch otel-v1-apm-service-map
    │
    ├── [metrics 파이프라인]
    │   └── → prometheus exporter (:8889)  ← kube-prometheus-stack이 ServiceMonitor로 scrape
    │
    └── [logs 파이프라인]   ← 현재 서비스들이 OTEL_LOGS_EXPORTER=none이므로 실제 유입 없음
        └── → loki (http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push)
```

**로그의 실제 경로 (OTel 아님):**
```
서비스 파드 stdout/stderr
    ↓
Promtail DaemonSet (monitoring 네임스페이스)
  → K8s Pod 레이블 자동 수집 (namespace, pod, container)
    ↓
Loki Gateway (monitoring/loki-gateway)
    ↓
PodLogs UI (fetchLogs → GET /loki/api/v1/query_range)
```

---

### 11-4. serviceName ↔ Namespace 매핑 (수정 완료)

OTel `serviceName`과 K8s namespace가 일치하지 않는 문제는 `SERVICE_TO_NAMESPACE` 명시적 매핑으로 해결됐다 (섹션 8 참고).

| OTel `serviceName` | 실제 K8s Namespace |
|---|---|
| `backend` | `utterai-api` |
| `cpu-worker` | `utterai-ai-cpu` |
| `ml-gpu-worker` | `utterai-ai-gpu` |
| `ai-service` | `utterai-ai-service` |
| `batch-worker` | `utterai-batch` |

---

### 11-5. KEDA ScaledObject 상세 (모니터링 관점)

KEDA가 관리하는 큐와 워커의 관계 — VOC UI에서 에러를 볼 때 원인 추적에 필요한 컨텍스트다.

**cpu-worker ScaledObject:**
```yaml
namespace: utterai-ai-cpu
scaleTargetRef: utterai-cpu-worker
minReplicaCount: 1  # 항상 최소 1개 유지
maxReplicaCount: 3
cooldownPeriod: 120s

triggers:
  - SQS: utterai-dev-audio-preprocess-queue  (queueLength: 5)
  - SQS: utterai-dev-report-analysis-queue   (queueLength: 5)
```

**ml-gpu-worker ScaledObject:**
```yaml
namespace: utterai-ai-gpu
scaleTargetRef: utterai-ml-gpu-worker
minReplicaCount: 0  # 메시지 없으면 0으로 scale-down
maxReplicaCount: 1
cooldownPeriod: 300s
scaleDown.stabilizationWindowSeconds: 300  # 5분 안정화 후 scale-down

triggers:
  - SQS: utterai-dev-gpu-inference-queue  (queueLength: 1, scaleOnInFlight: true)
```

`scaleOnInFlight: true` — 처리 중인 메시지(InFlight)도 카운트에 포함. GPU Worker가 처리 중인 동안 추가 인스턴스가 생성되는 것을 방지.

**TraceDetail 에서 발견한 에러 스팬 → SQS 큐 연결:**

| 에러 스팬 serviceName | 해당 SQS 큐 | KEDA 트리거 |
|---|---|---|
| `cpu-worker` | audio-preprocess-queue 또는 report-analysis-queue | utterai-cpu-worker-scaledobject |
| `ml-gpu-worker` | gpu-inference-queue | utterai-ml-gpu-worker-scaledobject |
| `backend` | 큐 발행자 — SQS sendMessage 실패 시 에러 | HPA (CPU 기반) |

---

### 11-6. OpenSearch 배포 구성

```yaml
StatefulSet: opensearch (utterai-observability)
  nodeSelector: karpenter.sh/nodepool=platform  ← platform NodePool에 고정
  resources: request 500m/2Gi, limit 1CPU/2Gi
  JVM: -Xms1g -Xmx1g  ← JVM 힙 = 컨테이너 메모리의 절반
  storage: 20Gi EBS gp2 (ReadWriteOnce)

initContainers:
  - sysctl vm.max_map_count=262144  (OpenSearch 필수 커널 파라미터)
  - chown 1000:1000 /data           (EBS는 root로 마운트, OpenSearch는 UID 1000)
```

**OpenSearch 단일 노드 운영의 제약:**
- `discovery.type: single-node` — 클러스터 없음
- `plugins.security.disabled: true` — 인증 없음 (클러스터 내부 접근만 허용)
- `DISABLE_SECURITY_PLUGIN=true`
- 고가용성 없음 (platform 노드 장애 시 트레이스 데이터 조회 불가)

---

### 11-6-1. OpenSearch 배포 방식 — EKS 자체 호스팅 vs Amazon OpenSearch Service (관리형)

"OpenSearch"라는 이름은 같지만, 실무에서는 배포 방식이 크게 두 갈래로 나뉜다. **이 프로젝트는 ① 자체 호스팅 방식을 쓴다.**

| 구분 | ① EKS 자체 호스팅 OpenSearch (이 프로젝트) | ② Amazon OpenSearch Service (AWS 관리형) |
|---|---|---|
| 배포 형태 | EKS 클러스터 안에 StatefulSet Pod로 직접 실행 (섹션 11-6) | AWS가 별도로 운영하는 완전관리형 서비스. EKS 클러스터 바깥의 리소스 |
| 설치 방식 | Helm chart 등으로 매니페스트를 직접 배포 — 클러스터에 상주하는 워크로드일 뿐, EKS 공식 애드온 목록(VPC CNI, CoreDNS, kube-proxy, EBS CSI 등)에 속하는 **관리형 애드온은 아니다** | AWS 콘솔/API/Terraform으로 "도메인(domain)"을 생성. EKS와는 VPC Peering/PrivateLink 등 네트워크로만 연결 |
| 클러스터링/HA | `discovery.type: single-node` — 단일 노드, 장애 시 전체 다운 (섹션 11-6) | Multi-AZ, 전용 마스터 노드, 자동 스냅샷 등 HA를 AWS가 관리 |
| 보안 | `plugins.security.disabled: true` — 인증 없음, 클러스터 내부망 접근만 허용 | IAM 정책, 파인그레인드 액세스 컨트롤(FGAC), VPC/IP 기반 접근 제어를 AWS가 제공 |
| 스케일링 | Karpenter `platform` NodePool 한도 내에서 수동 조정 (JVM 힙 등 파드 스펙을 직접 튜닝) | 콘솔/API로 인스턴스 타입·수량 변경, 무중단 블루/그린 배포 지원 |
| 운영 부담 | 팀이 직접 패치·백업·용량 계획·장애 대응 | AWS가 패치·백업·모니터링 상당 부분을 담당 (관리형 프리미엄만큼 비용 ↑) |
| 비용 구조 | EC2/EBS 비용만 발생 (Karpenter가 스팟/온디맨드 인스턴스를 선택) | 관리형 프리미엄이 붙은 인스턴스 시간당 과금 + EBS |

> **정리:** 두 방식 모두 동일한 오픈소스 OpenSearch 엔진을 쓰지만, **누가 운영·관리하느냐**가 본질적 차이다. 이 프로젝트는 dev 환경 비용 절감과 클러스터 내부 트래픽만 처리한다는 점 때문에 자체 호스팅(①)을 택한 것으로 보이며, 섹션 11-6에서 보듯 단일 노드·무인증 구성이라 프로덕션 수준의 HA/보안 요건이 생기면 Amazon OpenSearch Service(②)로의 마이그레이션을 고려해야 한다.

---

### 11-7. 전체 관찰 가능성 스택 컴포넌트 목록

| 컴포넌트 | 네임스페이스 | 역할 | 이 UI와의 관계 |
|---|---|---|---|
| OTel Collector | `utterai-observability` | 텔레메트리 수집·가공·라우팅 | 모든 트레이스/스팬의 진입점 |
| Data Prepper | `utterai-observability` | OTLP → OpenSearch JSON 변환 | ServiceMap·TraceDetail 데이터 생성 |
| OpenSearch | `utterai-observability` | 트레이스 저장 및 검색 | `fetchServiceMap`, `fetchTraceSpans`, `fetchErrorStats` 대상 |
| Loki | `monitoring` | 로그 저장 | `fetchLogs` 대상 |
| Tempo | `monitoring` | 트레이스 장기 저장 | (이 UI 미사용 — Grafana에서 사용) |
| Prometheus | `monitoring` | 메트릭 저장 | (이 UI 미사용 — Grafana에서 사용) |
| Grafana | `monitoring` | 대시보드 | (이 UI와 병행 사용) |
| kube-prometheus-stack | `monitoring` | Prometheus Operator + Alert Manager | PrometheusRule로 PodCrashLoop·APIHighErrorRate 등 알림 |

**PrometheusRule 알림 중 이 UI와 연관된 것:**

```yaml
# utterai-alerts (utterai-observability 네임스페이스)
UtterAIPodCrashLoopBackOff  → namespace=~"utterai-.*", 2분 지속
UtterAIPodPendingTooLong    → namespace=~"utterai-.*", 5분 지속 (Karpenter 실패 의심)
UtterAIGPUWorkerOOMKilled   → namespace="utterai-ai-gpu"
UtterAIAPIHighErrorRate     → 5xx 에러율 > 5%, 3분 지속
UtterAIAPIHighLatency       → p95 > 3초, 5분 지속
UtterAIGPUQueueDepthHigh    → gpu-inference-queue > 20개, 10분 지속
UtterAIAudioUploadFailureRateHigh → 업로드 실패율 > 10%, 5분 지속
```

→ Prometheus 알림이 발생했을 때 이 UI에서 해당 서비스의 트레이스를 찾아 로그로 드릴다운하는 것이 주요 사용 시나리오다.

---

### 11-8. OTel 민감정보 redact 처리

OTel Collector의 `attributes/redact` 프로세서가 다음 속성을 스팬에서 삭제한다:

```
http.request.header.authorization  ← JWT Bearer 토큰
http.request.header.cookie
http.response.header.set_cookie
http.url / url.full                ← 전체 URL (쿼리스트링 포함 가능성)
aws.s3.key                         ← S3 객체 키
audio.object_key / audio.key       ← 음성 파일 경로
rag.key                            ← RAG 인덱스 키
queue.name                         ← SQS 큐 이름
```

→ TraceDetail에서 스팬 `attributes`를 볼 때 위 키들은 표시되지 않는다.

---

## 12. 유저 식별 — 스팬 Attributes 전파 구조

에러가 어떤 유저에 의해 발생했는지 트레이스에서 직접 확인할 수 있도록 각 서비스에서 스팬에 유저 정보를 주입한다.

### 12-1. 주입 위치

| 레포 | 파일 | 스팬 | 주입 attribute |
|------|------|------|---------------|
| `UtterAI_BE` | `app/api/dependencies.py` | FastAPI HTTP 요청 스팬 (진입점) | `user.id`, `user.email` |
| `UtterAI_BE` | `app/infrastructure/sqs/client.py` | `sqs.publish.analysis_job` (PRODUCER) | `user.id` |
| `UtterAI_AI` | `app/workers/cpu_worker.py` | `worker.cpu.message` (CONSUMER) | `user_id` (기존) |
| `UtterAI_AI` | `app/workers/ml_gpu_worker.py` | `worker.ml_gpu.message` (CONSUMER) | `user.id` |

### 12-2. 전파 흐름

```
[HTTP 요청 스팬] — get_current_user()
  user.id = "uuid-..."
  user.email = "hong@example.com"
      │
      ▼
[sqs.publish.analysis_job] — SQSClient.send_analysis_job()
  user.id = "uuid-..."      ← payload에서 추출
      │  (SQS MessageAttributes로 TraceContext 전파)
      ▼
[worker.cpu.message] — cpu_worker
  user_id = "uuid-..."      ← JobMessage.user_id
      │  (cpu-worker → gpu-inference-queue 발행 시 MLGpuMessage.user_id 포함)
      ▼
[worker.ml_gpu.message] — ml_gpu_worker
  user.id = "uuid-..."      ← MLGpuMessage.user_id
```

### 12-3. VOC UI에서 확인하는 방법

**TraceDetail:** 스팬 클릭 시 `user.id`/`user.email`이 있으면 상세 패널 상단에 파란 USER 배지로 표시.

**TraceList:** 검색 모드를 `user.email`로 전환 후 이메일 입력 → 해당 유저의 트레이스 전체 조회.

OpenSearch DSL에서 `user.email`은 dot이 포함된 attribute key이므로 이스케이프가 필요하다:
```json
{ "term": { "attributes.user\\.email": "hong@example.com" } }
```
