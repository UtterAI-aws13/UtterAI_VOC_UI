# 모니터링 시나리오: ml-gpu-worker OOMKilled → 분석 job 실패 → 큐 누적

## 배경

언어재활사 A씨가 90분짜리 치료 세션 음성을 업로드하고 분석을 요청했다.
잠시 후 다른 유저들의 분석도 지연되기 시작하고,
Prometheus 알림이 울린다.

---

## 타임라인 (실제 장애 흐름)

```
11:42  A씨가 90분 오디오 업로드 완료 (S3 presigned URL → complete 호출)
11:42  BE: POST /api/v1/analysis/ → AnalysisJob 생성 → audio-preprocess-queue 발행
11:43  cpu-worker: 다운로드 → ffmpeg 변환 → Silero VAD → gpu-inference-queue 발행
11:44  ml-gpu-worker: pyannote 화자 분리 시작 (90분 오디오, VRAM 사용량 급증)
11:47  ml-gpu-worker: CUDA OOMKilled (컨테이너 강제 종료)
         → SQS 메시지 visibility timeout 만료 → 큐로 반환 (재처리 대상)
         → 이 시각부터 B씨, C씨의 분석 job도 gpu-inference-queue에 쌓이기 시작
11:47  Prometheus: UtterAIGPUWorkerOOMKilled 발생 (critical)
11:48  KEDA: gpu-inference-queue depth > 1 → ml-gpu-worker replica 증가 시도
         → 기존 노드 자원 없음 → Karpenter가 g4dn.xlarge 신규 프로비저닝 시작
11:52  새 노드 Ready (약 4분 cold start)
11:52  ml-gpu-worker 재기동 → A씨 job 재처리 시작 (90분 오디오, 또 OOM 위험)
11:53  운영자가 Prometheus 알림 확인 → VOC UI 접속
```

---

## 운영자 대응 (VOC UI 사용 흐름)

### Step 1. 에러 통계 탭 — 전체 현황 파악

에러 통계 탭을 열면 지난 15분 기준:

| 서비스 | 요청 | 에러 | 에러율 | p99 |
|---|---|---|---|---|
| backend | 12 | 0 | 0% | 210ms |
| cpu-worker | 4 | 0 | 0% | 8.2s |
| **ml-gpu-worker** | **3** | **2** | **66.7%** | **-** |
| ai-service | 6 | 0 | 0% | 1.4s |

→ ml-gpu-worker 에러율 66.7% 확인. backend와 cpu-worker는 정상이므로 **SQS 이전 단계는 이상 없음**.

---

### Step 2. Service Map 탭 — 서비스 간 관계 시각화

Service Map에서 ml-gpu-worker 노드가 **빨간색** (에러율 10% 초과).
backend → cpu-worker → ml-gpu-worker 흐름 확인.

ml-gpu-worker 노드 클릭 → 우측에 TraceList 패널 열림.

---

### Step 3. TraceList — 에러 트레이스 선택

최근 트레이스 목록:

```
TRACE ID   진입점                      시작시각    Duration
a1b2c3d4   worker.ml_gpu.message  ●  11:47:03   -        ← 에러 (빨간 행)
e5f6g7h8   worker.ml_gpu.message  ●  11:46:51   -        ← 에러
i9j0k1l2   worker.ml_gpu.message     11:43:12   312s     ← 성공
```

에러 트레이스 `a1b2c3d4` 클릭.

---

### Step 4. TraceDetail — Gantt 차트로 실패 단계 특정

```
backend          ██                              210ms
  sqs.publish    ███                             15ms
  cpu-worker       ████████████████████          72s
    sqs.publish                     ██           8ms
      ml-gpu-worker                    ███  ✗   193s  ← ERROR
```

**worker.cpu.message** 스팬 클릭:

```
┌─────────────────────────────────────────────────┐
│  USER   hong@utterai.com   id: 3f8a-...         │  ← USER 배지
└─────────────────────────────────────────────────┘
  Service   cpu-worker
  Status    STATUS_CODE_OK
  session_id  sess-0912-...
  job_id     job-1234-...
```

→ 영향받은 유저: **hong@utterai.com** 즉시 확인.

**worker.ml_gpu.message** 스팬 클릭:

```
  Service   ml-gpu-worker
  Status    STATUS_CODE_ERROR
  job_id    job-1234-...
  user.id   3f8a-...
```

→ ml_gpu_worker 단계에서 ERROR. "로그 보기 →" 클릭.

---

### Step 5. Pod Logs 드릴다운 — 에러 원인 확인

드릴다운 배너:
```
트레이스 드릴다운 — ml-gpu-worker · 11:46:03 ~ 11:47:10  [해제]
```

네임스페이스 `utterai-ai-gpu` 자동 선택. 해당 시간대 로그:

```
11:47:03.412  [ERROR] CUDA out of memory. Tried to allocate 2.50 GiB
              (GPU 0; 14.76 GiB total capacity; 11.82 GiB already allocated)
              OOM for tensor of shape (1, 4800000, 64) in pyannote.audio
11:47:03.413  [ERROR] ML GPU STAGE 실패: CUDA out of memory. Tried to allocate...
11:47:03.415  [WARN]  SQS 메시지 삭제 실패 (컨테이너 종료 중)
```

→ **원인 확정: 90분 오디오에서 pyannote 화자 분리 중 GPU VRAM 14.76GiB 초과.**

---

### Step 6. TraceList user.email 검색 — 추가 피해 유저 확인

검색 모드를 `user.email`로 전환 → `hong@utterai.com` 입력 → 검색.

A씨의 트레이스가 3건 조회됨 (재시도 포함). 모두 ml-gpu-worker 단계에서 ERROR.

→ A씨는 같은 job이 3회 실패한 상태.

---

### Step 7. 큐 누적 상황 파악

에러 통계 탭 시간 범위를 **1시간**으로 변경:

| 서비스 | 요청 | 에러 | 에러율 |
|---|---|---|---|
| ml-gpu-worker | 9 | 6 | 66.7% |

→ B씨, C씨 job도 실패 포함. 현재 `gpu-inference-queue`에 메시지 누적 중.

---

## 원인 요약

| 구분 | 내용 |
|---|---|
| **직접 원인** | 90분 오디오에서 pyannote 화자 분리 시 GPU VRAM(14.76GiB) 초과 |
| **연쇄 영향** | ml-gpu-worker OOMKilled → SQS 메시지 재처리 큐 복귀 → 재기동 후 동일 메시지 재처리 → 반복 OOM |
| **지연 원인** | ml-gpu-worker minReplica=0 → cold start 4분(Karpenter g4dn 프로비저닝) 동안 B씨·C씨 job 대기 |
| **잠재 문제** | A씨 job은 재시도해도 동일 오디오 → 무한 OOM 루프. visibility timeout heartbeat(1800s)로 큐 점유 지속 |

---

## 조치

### 즉시 (운영)

1. A씨 job을 DB에서 `CANCELLED`로 수동 마킹 → SQS 메시지 삭제
   - `kubectl exec` 또는 관리 API로 `update_analysis_job_status(job_id, CANCELLED)`
2. `gpu-inference-queue` 대기 메시지 수 확인 → B씨·C씨 job 정상 처리 여부 모니터링
3. A씨에게 "90분 이상 오디오는 현재 지원 범위 초과" 안내

### 단기 (코드)

| 위치 | 수정 내용 |
|------|----------|
| `UtterAI_BE` `audio.py` | 업로드 시 오디오 길이 검증. 예: 60분 초과 시 400 반환 |
| `UtterAI_AI` `analysis_pipeline.py` | `run_ml_gpu_stage` 진입 시 오디오 길이 체크 → 초과 시 `FAILED(AUDIO_TOO_LONG)` |
| `UtterAI_AI` `ml_gpu_worker.py` | OOMKilled 감지 후 해당 메시지를 DLQ로 이동 (무한 재시도 방지) |

### 중기 (인프라)

| 위치 | 수정 내용 |
|------|----------|
| `UtterAI_Infra` ml-gpu-worker | memory limit 명시 (현재 없음). OOMKill 발생 시 컨테이너 재시작으로 처리 |
| `UtterAI_Infra` KEDA ScaledObject | `maxReplicaCount` 4 → 유지하되 `queueLength` trigger를 job 크기 기반으로 분리 고려 |
| `UtterAI_Infra` PrometheusRule | `UtterAIGPUWorkerOOMKilled` 알림에 job_id 레이블 포함하여 바로 추적 가능하게 개선 |

---

## 이 시나리오에서 사용된 VOC UI 기능

| 기능 | 확인한 내용 |
|---|---|
| 에러 통계 탭 | ml-gpu-worker 66.7% 에러율 → backend·cpu-worker는 정상이어서 SQS 이전 단계 즉시 배제 |
| Service Map | ml-gpu-worker 노드 빨간색 → 노드 클릭으로 TraceList 진입 |
| TraceDetail Gantt | cpu-worker OK → ml-gpu-worker ERROR 경계 명확히 시각화 |
| USER 배지 | 영향받은 유저 `hong@utterai.com` 스팬 클릭 즉시 확인 |
| 로그 드릴다운 | 에러 스팬 시간대로 자동 이동 → `CUDA out of memory` 한 줄로 원인 확정 |
| user.email 검색 | A씨 전체 재시도 이력(3건) 조회 → 무한 루프 여부 파악 |
| 에러 통계 시간 범위 변경 | 1시간으로 확장 → B씨·C씨 피해 규모 파악 |
