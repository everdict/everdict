# 라이브 e2e 보조: 실 MLflow 3.x 백엔드에 browser-use 모양의 트레이스(에이전트→LLM→툴 스팬)를 만들고 trace_id 를 찍는다.
# MLflow 가 gen_ai.* 를 mlflow.chat.tokenUsage/mlflow.llm.model/.cost 로 정규화해 저장 → MlflowTraceSource 로 끌어 채점.
# 환경: MLFLOW_TRACKING_URI / MLFLOW_TRACKING_USERNAME / MLFLOW_TRACKING_PASSWORD (Basic auth).
# 사용: <venv>/bin/python scripts/live/mlflow-emit-trace.py   (mlflow-skinny 필요)
import os
import mlflow

mlflow.set_tracking_uri(os.environ.get("MLFLOW_TRACKING_URI", "http://127.0.0.1:5501"))
mlflow.set_experiment(os.environ.get("MLFLOW_EXPERIMENT", "assay-browseruse-trace"))


@mlflow.trace(name="browser_agent_run", span_type="AGENT")
def run():
    with mlflow.start_span(name="chat gpt-5.4-mini", span_type="LLM") as s:
        # OTel GenAI conventions — MLflow 3.x 가 이를 mlflow.chat.tokenUsage / mlflow.llm.model / .cost 로 정규화.
        s.set_attributes(
            {
                "gen_ai.request.model": "gpt-5.4-mini",
                "gen_ai.response.model": "gpt-5.4-mini",
                "gen_ai.usage.input_tokens": 42,
                "gen_ai.usage.output_tokens": 7,
                "gen_ai.usage.cost": 0.0012,
            }
        )
        s.set_inputs({"messages": [{"role": "user", "content": "Go to https://example.com and report the heading. End with DONE."}]})
        s.set_outputs("navigated to Example Domain. DONE")
    with mlflow.start_span(name="browser.navigate", span_type="TOOL") as t:
        t.set_attributes({"tool.name": "browser.navigate", "tool.call_id": "c1", "tool.result": "ok"})
    return "DONE"


run()
print("TRACE_ID=" + str(mlflow.get_last_active_trace_id()))
