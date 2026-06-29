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

#### `fetchRecentTraces(serviceName, limit=20) → TraceRow[]`

**인덱스:** `otel-v1-apm-span-*` (와일드카드 — 날짜별 롤링 인덱스)

**쿼리 조건:**
- `serviceName` 일치
- `kind`가 `SPAN_KIND_SERVER` 또는 `SPAN_KIND_CONSUMER` — 진입점 스팬만 필터링 (내부 클라이언트 스팬 제외)
- 최신순 정렬

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

드릴다운에서 OpenSearch의 `serviceName`을 Loki의 `namespace`로 연결할 때:

```
utterai-{serviceName}
```

예시:
| OpenSearch serviceName | Loki namespace |
|----------------------|----------------|
| `backend` | `utterai-backend` |
| `cpu-worker` | `utterai-cpu-worker` |
| `ml-gpu-worker` | `utterai-ml-gpu-worker` |

매핑된 네임스페이스가 실제 Loki 목록에 없으면 첫 번째 네임스페이스로 폴백.

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

- **Loki 프록시 추가** — `vite.config.ts`에 `/loki` 항목 필요
- **ServiceMap 실시간 갱신** — 현재 앱 마운트 시 1회만 로드. ErrorStats처럼 인터벌 추가 가능
- **절대 시간 범위 UI** — PodLogs의 드릴다운 모드는 range 셀렉터가 무시됨. UI에서 명시적으로 비활성화하거나 절대 시간 범위를 표시하면 더 직관적
- **TraceDetail parent/child 들여쓰기** — 현재 Gantt는 단순 시간축. `parentSpanId`를 활용한 트리 들여쓰기로 호출 계층 표현 가능
