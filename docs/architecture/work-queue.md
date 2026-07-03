# Work queue — 워크로드 가시성 (런타임 레인별 실행 중/대기/다음 예약)

예약 발사·유저의 스코어카드 실행·단발 run 은 모두 컨트롤플레인에 접수되어 큐잉/디스패치되는
**워크로드**다. 이 문서는 그 큐를 한 화면으로 보이게 하는 읽기 전용 가시성 슬라이스의 SSOT 다.

## 질문 → 답
- **지금 작업 큐 상황은?** — `queued`/`running` 상태의 스코어카드 배치 + standalone run 전부.
- **어떤 런타임에 스케줄링되어 있나?** — 레코드에 캡처된 `runtime`(placement.target) 축으로 레인 분류.
- **런타임마다 지금 무엇이 돌고 있나?** — 레인의 `running[]` (배치는 진행률 포함).
- **다음 작업은?** — 레인의 `queued[]` FIFO 맨 앞 + 활성 예약의 다음 발사(`upcoming[]`).

## 데이터 (mig `0040`, additive)
- `RunRecord.runtime` / `ScorecardRecord.runtime` — 제출 시 배치된 런타임을 스탬프
  (`RunService.submit`: 명시 runtime ?? case placement.target; `ScorecardService.submit`: input.runtime;
  배치의 자식 run 도 동일 값). **NULL = 기본 백엔드** 또는 과거 레코드. 경량 → `list` 포함.
- 레인 키: `''`(기본 백엔드) · 등록 런타임 id · `self:<runnerId>`(셀프호스티드).
  등록 런타임은 **빈 레인도 노출**한다("이 런타임은 유휴"가 정보다).

## 단위 (디자인 결정 — 사용자 확정)
**배치(스코어카드) = 1 작업**: 케이스 팬아웃(자식 run)은 항목으로 펼치지 않고 배치의
**진행률**(`progress { done, active, total? }`)로 접는다 — done/active 는 자식 run 카운트,
total 은 데이터셋 케이스 수(해석 실패 시 생략). standalone run 은 그대로 1 작업.

## 서비스/전송 (BFF↔MCP 패리티)
`QueueService.snapshot(tenant)` (`apps/api/src/queue-service.ts`) — 스토어 목록(경량)만으로 조립:
scorecards + runs(standalone) 의 활성 상태 + `ScheduleService.list` 의 `nextFireTimes`(Temporal
authoritative; 없으면 upcoming 생략 — cron 근사는 웹 예약 화면 영역) + `RuntimeRegistry.list`.
- HTTP: `GET /queue` (`runs:read`, viewer+)
- MCP: `get_queue` (동일 게이트)

## 웹 (`/{workspace}/queue`, 내비 '작업')
`widgets/queue-board` — 레인 카드(Server 아이콘 + 라벨 + 실행/대기 카운트, 유휴 배지)마다
3열: **실행 중**(진행률 바) | **대기(선입선출)**(맨 앞 '다음' 배지) | **다음 예약**(발사 시각).
항목은 고정 규격 행(52px): EntityRef 종류 아이콘(벤치마크/하니스) + 실행자 아바타 + 시각.
활성 작업이 있으면 `AutoRefresh`(5s)로 라이브 갱신, 전부 유휴면 폴링 없음.

## 한계 / 후속
- 대기 순서는 createdAt FIFO **근사**다 — 실제 디스패치 순서는 Scheduler(WFQ)/러너 lease 가 정하며
  테넌트 공정성으로 재배열될 수 있다. 셀프호스티드 lease 큐 depth 의 실측 노출은 후속.
- 취소/재정렬 등 큐 제어(쓰기)는 이 슬라이스 밖(읽기 전용).
- upcoming 은 Temporal 드라이버가 있을 때만(nextFireTimes). dev(무드라이버)는 빈 컬럼.
