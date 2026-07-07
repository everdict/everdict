# live e2e helper: build a browser-use-shaped trace (agent→LLM→tool spans) on a real MLflow 3.x backend and print the trace_id.
# MLflow normalizes gen_ai.* into mlflow.chat.tokenUsage/mlflow.llm.model/.cost and stores it → pulled via MlflowTraceSource for scoring.
# Env: MLFLOW_TRACKING_URI / MLFLOW_TRACKING_USERNAME / MLFLOW_TRACKING_PASSWORD (Basic auth).
# Usage: <venv>/bin/python scripts/live/mlflow-emit-trace.py   (needs mlflow-skinny)
import os
import mlflow

mlflow.set_tracking_uri(os.environ.get("MLFLOW_TRACKING_URI", "http://127.0.0.1:5501"))
mlflow.set_experiment(os.environ.get("MLFLOW_EXPERIMENT", "everdict-browseruse-trace"))


@mlflow.trace(name="browser_agent_run", span_type="AGENT")
def run():
    with mlflow.start_span(name="chat gpt-5.4-mini", span_type="LLM") as s:
        # OTel GenAI conventions — MLflow 3.x normalizes these into mlflow.chat.tokenUsage / mlflow.llm.model / .cost.
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
