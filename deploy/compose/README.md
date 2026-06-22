# Docker Compose — 웹 + API 풀스택

`apps/web`(Next.js, `:3001`)과 `apps/api`(Fastify 컨트롤플레인, `:8787`)를 한 번에 띄운다. dev/prod 분리.

이미지 정의: `apps/api/Dockerfile`, `apps/web/Dockerfile` (둘 다 멀티스테이지 — `dev` / `runtime` 타깃).
모든 빌드 컨텍스트는 **레포 루트**(`../..`) — pnpm 모노레포라서 워크스페이스 전체가 필요하다.

## dev — 빠른 풀스택 기동(핫리로드, 인증 OFF)

```bash
docker compose -f deploy/compose/docker-compose.dev.yaml up --build
```

- 웹 http://localhost:3001 · API http://localhost:8787
- 인증 없음: 웹은 dev 모드, API 는 dev-fallback(`x-assay-tenant`) → 바로 클릭 가능. 테넌트는 `default`.
- 저장소 **in-memory** → 재시작 시 초기화. 백엔드 **local**(이 머신 in-process).
- 소스를 컨테이너에 바인드마운트(리눅스 호스트 → node_modules 호환): 웹=`next dev`, API=`tsc -w`+`node --watch`.
- `claude-code` 하니스를 실제로 돌리려면 셸/`.env` 에 `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN`.
  (`scripted` 하니스는 토큰 없이 동작 — 스모크 테스트에 적합)

동작 확인:
```bash
curl localhost:8787/healthz
curl -XPOST localhost:8787/runs -H 'x-assay-tenant: default' -H 'content-type: application/json' -d '{
  "harness":{"id":"scripted","version":"latest"},
  "case":{"id":"c1","env":{"kind":"repo","source":{"files":{}}},"task":"...","graders":[{"id":"steps"}],"timeoutSec":120,"tags":[]}}'
```

> 컨테이너 없이 네이티브 핫리로드(Keycloak+API 도커, 웹은 호스트)는 `bash scripts/dev/up.sh` 도 있다.

## prod — 하드닝 풀스택(Postgres, Keycloak 없음)

```bash
cp deploy/compose/.env.example deploy/compose/.env   # 최소 POSTGRES_PASSWORD
docker compose -f deploy/compose/docker-compose.prod.yaml --env-file deploy/compose/.env up -d --build
```

차이점:
- **Postgres**(영속 볼륨, 기동 시 마이그레이션 자동 적용).
- 시크릿 at-rest 암호화(`ASSAY_SECRETS_KEY`) + 내부 토큰(`ASSAY_INTERNAL_TOKEN`) + 테넌트 run 예산(선택).
- `restart: unless-stopped` + 헬스체크 + `depends_on(healthy)`. 바인드마운트 없음(runtime 산출물 구동).

### ⚠️ 인증 (Keycloak 제거됨)
웹은 정적 API 키 경로가 없어 Keycloak 없이는 `x-assay-tenant=default` 로 동작한다. 그래서 API 도 인증을 강제하지
않는다(`ASSAY_REQUIRE_AUTH` 미설정) — 즉 **단일 테넌트 `default`, 인증 미강제**다. 이 스택은 **신뢰된 네트워크 /
리버스 프록시 뒤**를 전제로 한다(공개 인터넷에 그대로 노출하지 말 것).

실제 인증이 필요하면:
- **프로그램/MCP 접근만** → API env 에 `ASSAY_REQUIRE_AUTH=1` + `ASSAY_INTERNAL_TOKEN` 으로 `/internal/tenant-keys`
  에서 API 키(`ak_…`) 발급. 단 이 경우 웹 UI 는 인증 수단이 없어 동작하지 않는다.
- **사람 SSO** → 앞단에 oauth2-proxy 등 리버스 프록시를 두거나, Keycloak 을 다시 추가(`deploy/keycloak/` 참고).

## 이미지만 따로 빌드

```bash
docker build -f apps/api/Dockerfile --target runtime -t assay-api .   # 레포 루트에서
docker build -f apps/web/Dockerfile --target runtime -t assay-web .
```

> 참고: runtime 이미지는 신뢰성 우선으로 `/app` 전체(node_modules 포함)를 복사한다. 이미지 슬림화는
> `pnpm deploy --filter <pkg> --prod` 또는 Next standalone(`output: 'standalone'`) 으로 후속 최적화 가능.
