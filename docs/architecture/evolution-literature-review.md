---
kind: wiki
title: "Evolution literature: WikiSkill, its references, and implications for Everdict"
status: current
updated: 2026-09-10
---
# Evolution literature: WikiSkill and the research around it

Everdict should use execution experience to improve the next candidate, then measure whether that learning
transfers to new work. The strongest research direction is a combination of maintained knowledge, structured
skill and harness edits, and a diverse candidate archive. This is a synthesis for Everdict, not a claim that
any one paper validates the combined system. The companion [change proposal](evolution-research-directions.md)
turns these findings into prioritized choices and experiments.

## Scope and evidence

This review covers **60 sources**: WikiSkill itself, **all 46 entries in WikiSkill v1’s bibliography**, and
13 additional research papers selected for memory, program search, and open-ended evolution. Of the 46
direct references, 39 are research papers, surveys, or technical reports; seven are guides, announcements,
a model card, or a design note. Including the seed and additions gives **53 research publications and seven
other resources**. “All” refers to this closed bibliography, not every paper on evolution or the recursive
transitive closure of every cited work. The additions are explicitly separated from WikiSkill’s references.

Sources were checked on **2026-09-10**. Versioned arXiv links in the bibliography identify the inspected
revision; a bibliography’s conference year can differ from a preprint’s first-posted year. Where the
publisher or OpenReview page was blocked, the author-uploaded arXiv version supplied the research content.
No reported experiment was independently reproduced, and no cross-paper leaderboard is constructed from
incompatible models, splits, budgets, or metrics. Repository observations refer to main at
`42f5c7abc724b2e914b4efee9666cf68794f6748`.

Reading depth is explicit: **F** means methods and relevant evaluation or limitations sections were
inspected; **A** means abstract and bibliographic screening; **R** means an official non-paper resource was
read; **L** means only its landing page and bibliographic identity could be checked. F does not mean every
appendix or released implementation was audited. Priority means usefulness for Everdict’s next experiments:
**Now**, **Next**, **Later**, or **Context**, rather than a ranking of scientific quality.

## The seed: WikiSkill

**S00 — WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution**, Tang et al. (2026),
is the primary reference (Now / F). It separates raw execution history, a maintained wiki, and active skills;
the wiki survives rejected skill updates. Its proposer uses accumulated experience while the executor
receives the skills being tested. Selection accepts strict validation improvements.[^1]

Table 3’s Gemini-3.5-Flash ablation averages **four** benchmarks: proposer wiki access changes 48.7 to 63.7
(**+15.0 percentage points**) with executor access disabled; adding executor access changes 63.7 to 60.9
(**−2.8 points**). Removing proposer access also removes the maintainer, so this does not isolate wiki
topology against a same-budget flat history. Skills are directly supplied; retrieval and very long tasks
remain outside the demonstrated setting.[^1]

For Everdict, the useful hypothesis is that durable, source-linked development knowledge can make proposals
more productive. The executor-access ablation does not establish that runtime memory is universally harmful
or that the measured loss was benchmark leakage. Evaluate a deployed memory system as part of the candidate
when that is the intended product behavior. Keep selection evidence out of development memory according to
the evaluation protocol, independently of the paper’s ablation.

## Complete direct-reference inventory

R01–R46 follow the order of WikiSkill v1’s bibliography. Each entry has a primary-source bibliography link,
an explicit screening depth, and an Everdict implication with its principal limitation.

| ID | Work | Priority / depth | Research role | Mechanism and implication for Everdict |
|---|---|---|---|---|
| R01 | GEPA (2026)[^2] | Now / F | Prompt search | Reflect on execution traces; select complementary per-case winners and sometimes merge compatible prompt changes. Use for parent selection and diagnosis; a development frontier is not an adoption verdict. |
| R02 | EvoSkill (2026)[^3] | Now / F | Skill generation | Separate proposal and skill building around a frozen executor; retain proposal history. A useful driver baseline, but its top-k replacement procedure should not be treated as proof of behavioral diversity. |
| R03 | The complete guide to building skills for Claude (2026)[^4] | Context / R | Authoring guide | Practical skill packaging and authoring conventions. Useful for portable candidate bundles and activation descriptions; it supplies no controlled evidence that an evolution algorithm improves. |
| R04 | SkillCraft (2026a)[^5] | Next / A | Composition benchmark | Evaluate acquisition and reuse of executable tool compositions across tasks. Measure whether Everdict creates reusable capabilities and saves work, not merely whether a skill file was generated. |
| R05 | HarnessX (2026b)[^6] | Next / F | Harness composition | Typed primitives and trace-driven adaptation broaden the mutation space to tools, memory, control flow, and model training. Start with component substitutions; its combined system does not isolate the contribution of each part. |
| R06 | SkillRet (2026)[^7] | Next / F | Retrieval benchmark | Large skill corpus with task-to-skill retrieval evaluation and disjoint skill pools. Test discovery under unfamiliar tasks and skills; retrieval ranking alone does not establish downstream task improvement. |
| R07 | Gemma 4 Technical Report (2026)[^8] | Context / A | Model report | Documents an executor family used by WikiSkill. Pin model and serving identity when testing transfer; its model results are background, not evidence for a skill evolution method. |
| R08 | Gemini 3.5 Flash model card (2026)[^9] | Context / L | Model card | Identifies the model used for WikiSkill’s ablation. The landing page was accessible but detailed card content was not assessed here; no capability or model-selection claim depends on it. |
| R09 | LiveMathematicianBench (2026)[^10] | Next / A | Reasoning benchmark | Recent-paper theorem questions and proof-sketch-aware evaluation address memorization and reasoning sensitivity. Useful as a transfer challenge, but every live release needs a frozen dataset identity for comparison. |
| R10 | AA-Omniscience (2025)[^11] | Next / A | Calibration benchmark | Jointly measures factual recall and uncertainty handling, including penalties for wrong answers. Add calibration and abstention to evolution objectives where relevant; higher task completion alone can hide worse reliability. |
| R11 | SoK: Agentic Skills (2026)[^12] | Context / A | Survey | Maps discovery, practice, distillation, storage, composition, evaluation, and update. Use its lifecycle to check coverage and distinguish language, code, and policy skills; a survey is not an optimizer comparison. |
| R12 | LLM Wiki (2026)[^13] | Now / R | Design note | Describes compiling sources into linked, maintained knowledge. Useful inspiration for a source-to-knowledge projection; it is a design note, without a controlled agent-performance experiment. |
| R13 | PagedAttention (2023)[^14] | Context / A | Serving infrastructure | Efficient KV-cache management and sharing improve serving throughput. Relevant when evolution cost is dominated by repeated rollouts; this is an execution optimization, not a learning mechanism. |
| R14 | Meta-Harness (2026)[^15] | Now / F | Harness search | An outer coding agent explores harness source and prior execution evidence through files and tools. Give the proposer layered access to exact development traces; do not force every history into one prompt summary. |
| R15 | SkillsBench (2026)[^16] | Now / F | Skill utility benchmark | Matched runs with and without curated skills quantify downstream benefit across domains. Use as a control design; curated, directly supplied skills do not establish autonomous generation or production retrieval quality. |
| R16 | SkillNet (2026)[^17] | Next / F | Skill infrastructure | Connects skill creation, relationships, evaluation, and reuse at scale. Reuse Everdict’s existing knowledge graph and versioned skills; catalogue size and descriptive quality scores do not themselves prove task gains. |
| R17 | Agentic Harness Engineering (2026)[^18] | Now / F | Harness search | Exposes editable components, drill-down execution history, and predictions about edits. Use these to target structural mutations and compare expected effects with outcomes; predictions still require controlled ablations for causal attribution. |
| R18 | How Well Do Agentic Skills Work in the Wild (2026)[^19] | Now / F | Realistic skill usage | Tests the gap between curated relevant skills and skills found in a noisy public corpus. Make imperfect retrieval and task-specific adaptation part of evaluation; ideal skill injection overstates deployed usefulness. |
| R19 | AutoHarness (2026)[^20] | Next / F | Executable adaptation | Synthesizes code that prevents illegal actions, sometimes replacing repeated model decisions with executable policies. Prefer a small verified helper for deterministic constraints; game legality does not cover open-ended task correctness. |
| R20 | SKILL0 (2026)[^21] | Later / F | Weight adaptation | Gradually withdraws skill context during reinforcement learning to internalize behavior. Relevant to eventual model evolution, with a new model identity and separate transfer tests; it is not a no-training markdown update. |
| R21 | SpreadsheetBench (2024)[^22] | Now / A | Artifact benchmark | Real spreadsheet tasks use multiple input workbooks per instruction to test robust solutions. Measure transferable artifact manipulation, including values and structure; avoid using only one visible example as the objective. |
| R22 | Terminal-Bench (2026)[^23] | Now / A | Execution benchmark | Difficult terminal tasks provide environments and executable verification. The existing Everdict importer makes it a practical pilot; task tests must remain independent of mutable harness code. |
| R23 | Trace2Skill (2026)[^24] | Now / F | Trace distillation | Analyze individual successful and failed trajectories, then consolidate compatible transferable patches. Use source-linked diagnosis before synthesis; unresolved failure explanations should remain hypotheses rather than unconditional skills. |
| R24 | SkillOS (2026)[^25] | Later / F | Learned curation | Trains a curator against delayed benefits of skill maintenance across task streams. Evaluate curation by later task utility, not by prose quality; reinforcement-learning infrastructure and curator training are additional costs. |
| R25 | GDPval (2026)[^26] | Next / A | Work-product benchmark | Professional tasks evaluate deliverable quality across occupations. Useful for checking whether improvements reach realistic work products; grading and domain coverage differ from deterministic coding-task evaluation. |
| R26 | SealQA (2026)[^27] | Next / A | Search reasoning benchmark | Conflicting, noisy, or unhelpful search results stress evidence use. Test evolved retrieval and verification strategies under distraction; extra inference effort is not automatically useful reasoning. |
| R27 | Humanity’s Last Exam (2026)[^28] | Context / A | Academic benchmark | Expert-level closed-ended questions expose remaining capability and calibration gaps. A broad transfer probe, but a poor sole objective for a platform focused on interactive harness and artifact behavior. |
| R28 | Qwen3.5: Towards native multimodal agents (2026a)[^29] | Context / L | Model announcement | A model-family reference in WikiSkill. The cited JavaScript page exposed only a generic landing description here; retain it for bibliography completeness, without inferring architecture or performance details. |
| R29 | Qwen3.6-27B (2026b)[^30] | Context / L | Model announcement | Another executor reference in WikiSkill. Detailed announcement content was not accessible in the retrieved page; exact model and serving configuration must be resolved before any transfer experiment. |
| R30 | Skill1 (2026)[^31] | Later / F | Joint skill learning | Uses reinforcement learning to optimize skill selection, utilization, and distillation together. Useful for eventual joint credit assignment; early Everdict work can first measure these stages without training a new policy. |
| R31 | ALFWorld (2021)[^32] | Next / A | Interactive benchmark | Text environments align abstract planning with embodied tasks. Useful for repeated-action failures and reusable procedures; adding it to an Everdict pilot requires an adapter and pinned environment, not just an imported score. |
| R32 | OfficeQA (2025)[^33] | Next / R | Benchmark announcement | Grounded reasoning over enterprise-style documents, based on U.S. Treasury Bulletins. Useful for document navigation and cross-source synthesis; distinguish this official technical announcement from a peer-reviewed optimizer paper. |
| R33 | Skill Retrieval Augmentation for Agentic AI (2026)[^34] | Now / F | Skill usage pipeline | Separates retrieval, incorporation, and execution, including relevant and distracting skills. Instrument each stage and compare task outcomes; loading a document is not evidence that the agent followed it effectively. |
| R34 | SkillGrad (2026)[^35] | Now / F | Structured skill editing | Uses contrastive execution feedback and momentum-like history to target metadata, instructions, or resources. Try bounded edits and preserve successful behaviors; textual gradients are optimization feedback, not exact mathematical derivatives. |
| R35 | SkillRL (2026a)[^36] | Later / F | Skill-augmented RL | Distills experience into hierarchical skills and couples skill evolution with reinforcement learning. Useful for long-term training integration; compare the full training cost and changed model against frozen-model alternatives. |
| R36 | MetaClaw (2026b)[^37] | Later / F | Continual adaptation | Combines rapid skill updates with slower background weight adaptation. Separate deployment snapshots and learning windows; improvements from changing skills and weights need distinct identities and comparisons. |
| R37 | Agent Skills for Large Language Models (2026)[^38] | Context / A | Survey | Reviews architecture, acquisition, deployment, and skill lifecycle governance. Helps classify candidate types and portability constraints; its broader survey claims are not separately reproduced or used as measured Everdict outcomes. |
| R38 | SkillOpt (2026)[^39] | Now / F | Skill optimization | Aggregates successes and failures separately, schedules bounded text edits, and retains feedback at multiple timescales. A strong first optimizer baseline; selection feedback must remain distinct from final confirmation. |
| R39 | ReAct (2023)[^40] | Context / A | Agent architecture | Interleaves reasoning and environment actions to improve grounding and recovery. Provides a baseline execution pattern and trace structure; it does not itself maintain an evolution archive or learn reusable cross-task skills. |
| R40 | Meta Context Engineering (2026)[^41] | Next / F | Optimizer evolution | A meta-agent evolves the engineering skills that a base agent uses to build contexts. Make the evolution procedure itself a versioned experimental subject; the paper still uses a fixed outer orchestration algorithm. |
| R41 | TextGrad (2025)[^42] | Now / A | Textual optimization | Propagates language feedback to components of a computation graph. Useful for mapping observed failure to editable components; an LLM explanation is proposed credit assignment, not proof that a component caused the error. |
| R42 | Equipping agents for the real world with Agent Skills (2025)[^43] | Context / R | Engineering article | Explains modular skill bundles and progressive loading of instructions and resources. Use as an interoperability baseline; packaging conventions do not establish which skills should be generated or retained. |
| R43 | Self-Harness (2026a)[^44] | Now / F | Harness self-improvement | Cycles through weakness discovery, diverse focused proposals, and regression validation using the target model. Compare proposer choices empirically; successful self-improvement on one model need not transfer to another. |
| R44 | CoEvoSkills (2026b)[^45] | Next / F | Skill/verifier co-evolution | Alternates skill generation with an independently prompted surrogate verifier. Useful for development counterexamples; binary hidden-oracle feedback still informs search, and a co-evolved verifier cannot certify its own candidate independently. |
| R45 | SkillRouter (2026)[^46] | Now / F | Skill routing | Uses skill content to improve routing in large catalogues. Evolve activation descriptions and routing together with skill bodies; retrieval hit rate must be followed by execution and task-utility measurement. |
| R46 | Memento-Skills (2026)[^47] | Next / F | Persistent skill memory | A read-write reflective learner retrieves and revises external skills, including learned routing. Distinguish a continually changing deployed memory from a frozen evaluated artifact; self-generated tests do not replace external confirmation. |

## Additional research selected for Everdict

These 13 additions are **not entries in WikiSkill’s direct bibliography**. They fill specific gaps in that
list: episodic-memory baselines, code and workflow search, behavioral diversity, and generated curricula.
Publication labels below identify the consulted work; some papers first appeared as earlier preprints.

| ID | Work | Priority / depth | Mechanism, relevance, and limit |
|---|---|---|---|
| E01 | Reflexion (2023)[^48] | Now / A | Verbal feedback stored across attempts is the simplest memory baseline. Compare against curation before building a larger wiki; episode-level reflection is not automatically cross-task generalization. |
| E02 | Self-Refine (2023)[^49] | Context / A | Iteratively critique and revise an output with the same model. Useful as a candidate-local control, but improved output on one task is not evidence of a reusable evolved agent. |
| E03 | Voyager (2023)[^50] | Next / A | Combines automatic curriculum, executable skill storage, and reuse in Minecraft. Connect task discovery to durable capabilities; its environment-specific progress measures need an Everdict-specific analogue. |
| E04 | Automated Design of Agentic Systems (2024)[^51] | Now / A | Meta Agent Search writes new agent programs using an archive of earlier designs. Broaden candidates to workflows and tools; expressiveness of code does not establish efficient search over every program. |
| E05 | AFlow (2025)[^52] | Now / F | An MCTS variant searches complete code workflows and records parent-relative changes and outcomes. A useful alternative driver with explicit exploration and repeated evaluation; compare total cost, including repeated trials. |
| E06 | Darwin Gödel Machine (2025)[^53] | Now / F | Maintains an archive of viable self-modifying coding agents so stepping stones can produce later improvements. Keep neutral parents available for exploration; the archive selector itself remains fixed in the reported system. |
| E07 | AlphaEvolve (2025)[^54] | Now / F | Evolves code with evaluator cascades and a diverse program database. Filter invalid candidates cheaply before expensive evaluation; applicability depends on executable objectives and does not make adaptive tests independent. |
| E08 | Agentic Context Engineering (ACE) (2025)[^55] | Now / F | Uses incremental playbook edits, reflection, curation, and deduplication to avoid destructive full rewrites. Compare localized maintenance with flat summaries; larger memory still needs utility and cost measurement. |
| E09 | ReasoningBank (2025)[^56] | Now / F | Distills successful and failed experiences into retrieved strategies, with contrastive memory-aware scaling. Test whether extra exploration improves future tasks; its self-judged outcomes remain proxy signals. |
| E10 | MAP-Elites (2015)[^57] | Next / A | Preserves high-quality solutions across chosen behavioral dimensions. Use to maintain capability specialists and cost alternatives; manually chosen archive dimensions can misrepresent meaningful diversity. |
| E11 | POET (2019)[^58] | Later / A | Co-evolves environments and their agents, transferring solutions between challenges. Inform development curricula while freezing external confirmation tasks; harder generated tasks alone do not prove broader capability. |
| E12 | FunSearch (2023/2024)[^59] | Next / A | Pairs language-generated programs with systematic evaluation to discover reusable algorithms. A precedent for executable skill search; the function space and evaluator define what improvement means. |
| E13 | DSPy (2023)[^60] | Next / A | Defines compositional language-model programs whose parameters can be compiled against a metric. Separate program structure from optimizable prompts and examples; compiler integration is an experiment, not a required new platform dependency. |

## What the research changes about the evolution model

### Learning has several distinct products

“Evolution” covers different objects with different evidence requirements. A task answer can improve without
creating a reusable capability, and a growing skill library can still fail to improve the deployed agent.
For Everdict, each experiment should name which object changes and which future behavior should benefit.
The following taxonomy is a synthesis of the cited mechanisms, rather than a taxonomy claimed by one paper.

| Evolving object | Representative sources | Reusable output to measure |
|---|---|---|
| One task’s answer or trajectory | E01, E02 | Better completion of that task; only a baseline for persistent learning |
| Development knowledge and context | S00, E08, E09 | Better proposals or future task performance after new experience |
| Skills and their routing | R02, R23, R33, R34, R38, R45 | Reusable instructions or code that are found, applied, and helpful |
| Harness tools, memory, and workflow | R05, R14, R17, R19, R43, E04, E05 | A new executable system with improved behavior under fixed evaluation |
| Search and curation procedures | R24, R40 | Better downstream candidates per total search budget |
| Model weights or task curricula | R20, R30, R35, R36, E03, E11 | Transfer under a newly identified model or development environment |

### 1. Preserve experience, then turn it into testable advice

Trace2Skill grounds lessons in individual trajectories before consolidation; it treats successful behavior
as something to preserve and investigates failures before generalizing them. ACE instead emphasizes small
playbook updates with item identities and deduplication. ReasoningBank extracts reusable strategies from
both successful and failed experiences, but uses self-judged correctness signals.[^24][^55][^56]

The Everdict inference is to retain exact development evidence and maintain a separate, editable advisory
projection over it. A useful entry should explain when a strategy applies, its supporting observations, and
the cases that contradict it. An attractive explanation of a failed run is still a hypothesis until later
observations support it. Compare this projection with existing round notes and with a flat history at the
same token and total compute budgets; otherwise a gain might come from simply providing more context.

### 2. Choose the right mutation surface

SkillOpt schedules bounded edits and separates successful and failed rollout feedback. SkillGrad targets
the relevant layer of a skill bundle using contrastive feedback and accumulated optimization history.
TextGrad supplies a broader model for propagating textual feedback toward editable components. These are
related optimization ideas, not demonstrations of exact derivatives through arbitrary agent behavior.[^39][^35][^42]

Meta-Harness, Agentic Harness Engineering, and Self-Harness widen the object being edited to the executable
harness and emphasize access to prior observations. AutoHarness demonstrates a more specialized option:
compile constraints into executable control logic. HarnessX adds a compositional representation of harness
primitives.[^15][^18][^44][^20][^6]

For Everdict, a repeated formatting mistake could call for a small skill edit, a missed capability for a
routing change, and an illegal action for a deterministic tool wrapper. Store that diagnosis before building
the candidate, together with the predicted effect and the behaviors that must survive. Prefer focused edits
for a clear failure; permit a separately budgeted structural branch when local edits repeatedly plateau.
The proposal should explain why its chosen surface can change the observed failure mechanism.

### 3. Search needs useful alternatives, not only the latest winner

GEPA retains candidates that lead on different development instances and can combine compatible prompt
changes. AFlow searches whole workflows using a tree of modification experience and repeated evaluation.
Darwin Gödel Machine retains viable coding agents that may later become useful ancestors; its outer archive
selection procedure is fixed in the reported system.[^2][^52][^53]

AlphaEvolve uses a diverse program database and cascaded evaluation, while MAP-Elites explicitly preserves
quality across chosen behavioral dimensions. These are different selection policies; a list of the top-k
mean scores is not interchangeable with a capability-diverse archive. A scalar-neutral variant can contain
a capability that becomes valuable after another change.[^54][^57]

Everdict should experimentally separate “eligible as a search parent” from “qualified for adoption.” A
bounded archive can preserve a candidate that solves a new development case or changes the cost tradeoff,
while adoption continues to require fresh evidence against the campaign baseline. Parent versions should
describe actual reused artifacts; knowledge influence is a different relation. A merged descendant needs
new measurement, regardless of how strong either parent was.

### 4. Skill quality includes discovery and application

SkillsBench measures the usefulness of supplied skills, whereas SkillRet and SkillRouter examine finding
skills in a larger collection. Skill Retrieval Augmentation distinguishes retrieval from incorporation
and execution. The “in the wild” study tests less ideal skill availability than hand-selecting a relevant
document for every task.[^16][^7][^46][^34][^19]

Everdict should therefore compare three experimental conditions: no skills, researcher-selected relevant
skills, and production retrieval. The middle condition diagnoses capability potential; the final one
measures the intended product. Record the returned candidates, the exact body loaded, and observable action
evidence separately. A load event cannot establish that the agent used a rule, and a relevant retrieval
cannot establish that the rule improved the result.

### 5. The learning procedure can itself become a candidate

Meta Context Engineering evolves the skills used to construct contexts, so it optimizes how adaptation is
performed as well as the resulting context. SkillOS trains skill curation against effects on later tasks.
Memento-Skills combines reflective skill updates with routing. These approaches motivate measuring the
learning process across a sequence, rather than scoring a curator’s prose in isolation.[^41][^25][^47]

The Everdict inference is a nested but bounded experiment: hold task families and total budget fixed,
compare two proposer or curator versions, and measure the quality of the candidates they subsequently
produce. The proposed optimizer cannot award itself a better adoption result. Start with configurable
procedures; adding learned policies or model training should follow evidence that a fixed procedure is the
bottleneck. The reported methods do not establish unrestricted recursive self-improvement.

### 6. New tests can aid discovery while changing the measurement problem

CoEvoSkills uses a surrogate verifier that evolves alongside the generated skills; binary hidden-oracle
feedback can expose verifier mismatches. POET explores a different idea: jointly generate environments and
agents, with transfer between challenges. Both motivate richer development signals, but their roles differ
from a frozen external comparison.[^45][^58]

For Everdict, generated counterexamples should first enrich a development corpus. Confirmation cases must
remain separately identified and unavailable for adaptive diagnosis under the declared protocol. Repeatedly
asking a hidden evaluator for a binary result still provides adaptive information; hiding its raw answers
does not make that feedback free. Changing the benchmark or judge creates a new measurement frame, even if
it discovers a useful weakness.

## Selected empirical results and their limits

These are author-reported observations in the inspected revisions, not a leaderboard or expected Everdict
gains. They anchor the proposed experiments in measured effects while retaining the conditions that make
the numbers meaningful. An improvement from a different model, task split, or search budget cannot be added
to another row’s improvement.

| Work | Reported result | Conditions and interpretation |
|---|---|---|
| EvoSkill, R02 | OfficeQA 60.6% → 67.9%; SealQA 26.6% → 38.7% | Frozen underlying model with evolved skills; +7.3 and +12.1 percentage points in the authors’ settings. Supports testing transferable skill generation, not assuming equivalent gains on another harness.[^3] |
| SkillsBench v4, R15 | Mean pass rate 33.9% → 50.5%, +16.6 points | 87 tasks, eight domains, 18 model-harness configurations, matched no-skill and curated-skill conditions. Measures supplied skill utility; it does not measure autonomous discovery.[^16] |
| AHE v4, R17 | Terminal-Bench 2 pass@1 69.7% → 77.0% after ten iterations | Shows that structural harness adaptation can matter in the reported setup. Repeated search on an evaluation population must be distinguished from a fresh generalization claim.[^18] |
| SkillRouter v5, R45 | 74.0% Hit@1 for its body-aware pipeline; hiding bodies reduces routing accuracy by 37–44 points across tested baselines | Approximately 80,000 candidate skills in a SkillsBench-derived routing benchmark. These are retrieval metrics, not percentage-point gains in downstream task completion.[^46] |

## Tensions that matter for Everdict

| Tension in the research | What the evidence permits | Proposed Everdict resolution |
|---|---|---|
| Concise portable skills versus large retrieved memory | Supplied skills and continually updated memory are different evaluated systems | Compare both as explicit candidate modes; freeze or record the memory state and task order |
| Strict improvement versus stepping stones | Selection can reject a deployment while an archive preserves a useful ancestor | Keep search retention independent of adoption, with a finite exploration budget |
| General knowledge versus model-specific behavior | Transfer is empirical; neither a stronger proposer nor a longer skill is universally better | Evaluate a proposer × executor matrix and retain applicability limits |
| Rich feedback versus evaluator independence | Detailed traces improve diagnosis; adaptive confirmation feedback can bias selection | Diagnose on development evidence and reserve a declared confirmation stage |
| More memory versus lower overhead | Additional context can help but curation and retrieval consume resources | Compare total search cost, memory size, and future-task utility together |
| Automatic curation versus trustworthy knowledge | Self-reflection provides a candidate explanation, not independent truth | Label machine advice and retain source links, contradictions, and uncertainty |

## Findings against the current repository

Everdict already has fixed campaign frames, version-bound candidates, evidence-backed rounds, inherited
findings, and first-party evolution procedures. The relevant source is
[campaign contracts](https://github.com/everdict/everdict/blob/42f5c7abc724b2e914b4efee9666cf68794f6748/packages/contracts/src/records/evolution-campaign.ts),
[campaign service](https://github.com/everdict/everdict/blob/42f5c7abc724b2e914b4efee9666cf68794f6748/packages/application-control/src/evolution/campaign-service.ts), and
[round briefs](https://github.com/everdict/everdict/blob/42f5c7abc724b2e914b4efee9666cf68794f6748/packages/domain/src/evolution/round-brief.ts). Thus the research direction is to improve
how those capabilities generate and select candidates, rather than to repeat the completed platform work.

The current knowledge layer already represents source provenance, evidence links, applicability pins, and
superseding claims in [knowledge entries](https://github.com/everdict/everdict/blob/42f5c7abc724b2e914b4efee9666cf68794f6748/packages/contracts/src/records/knowledge-entry.ts).
[Task context assembly](https://github.com/everdict/everdict/blob/42f5c7abc724b2e914b4efee9666cf68794f6748/packages/application-control/src/knowledge/knowledge-service.ts) also exposes
listing-level skills for selective loading. A dedicated evolution wiki should build on those facilities;
it still needs a reproducible snapshot because entry content and lifecycle state can change. Existing
version pins identify what a claim concerns, which is different from freezing the claim’s own bytes.

One research citation needs correction in a subsequent source change: the comment above `learned` in the
campaign contract says **43.8% → 63.7%**. Table 3’s matched average is **48.7% → 63.7%**; 43.8 is a different
configuration’s LiveMath cell. The claim that this proves a universal prohibition on runtime knowledge also
exceeds the experiment. Correct the statistic and preserve the conditions when updating that code comment.
This research change records the correction; it does not edit runtime source.

The previously documented diverged-comparison defect is already repaired at the inspected repository
revision. Its [review record](evolution-review-2026-09-10.md) now records the merge-base refusal and closure.
It is an existing evaluation prerequisite, not a newly proposed evolution feature or an open finding here.

## Reading and adoption order

The first reading group is **WikiSkill → Trace2Skill → SkillOpt → ACE / ReasoningBank**. It supplies the
smallest useful experience-to-candidate loop and the baselines needed to discover whether a maintained wiki
adds value. The second is **GEPA → Darwin Gödel Machine → AFlow / AlphaEvolve**, which expands selection
beyond repeatedly editing the latest best version. The third is **Agentic Harness Engineering → SkillRouter
→ Skill Retrieval Augmentation**, which makes the learned artifacts operationally useful.

Read **Meta Context Engineering and SkillOS** after the first loop produces measurable learning curves.
Use **HarnessX, SkillCraft, Voyager, and POET** to widen the mutation and curriculum spaces as the platform
learns which capabilities are missing. Keep the weight-training family as a later branch with its full
training and evaluation cost visible. These priorities are engineering recommendations for this repository,
not conclusions that the later papers are less valuable scientifically.

This is a dated research snapshot. Refresh the catalogue when WikiSkill adds references, a selected paper
changes its method or evaluation materially, or an Everdict experiment supports or refutes an application
hypothesis. Preserve the inspected version and record the changed conclusion.

## Bibliography

All sources below were accessed on 2026-09-10. Preprint versions are pinned where available.

[^1]: Tang, L., Rashtchian, C., Ferng, C.-S., Tomkins, A., Juan, D.-C., and Vu, T. (2026). *WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution*. [arXiv:2608.27454v1](https://arxiv.org/abs/2608.27454v1), especially §§3, 5.1 and limitations.

[^2]: Agrawal et al. (2026). *GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning*. [Primary source](https://arxiv.org/abs/2507.19457v2).

[^3]: Alzubi et al. (2026). *EvoSkill: Automated Skill Discovery for Multi-Agent Systems*. [Primary source](https://arxiv.org/abs/2603.02766v1).

[^4]: Anthropic (2026). *The complete guide to building skills for Claude*. [Primary source](https://claude.com/blog/complete-guide-to-building-skills-for-claude).

[^5]: Chen et al. (2026a). *SkillCraft: Can LLM Agents Learn to Use Tools Skillfully?*. [Primary source](https://arxiv.org/abs/2603.00718v2).

[^6]: Chen et al. (2026b). *HarnessX: A Composable, Adaptive, and Evolvable Agent Harness Foundry*. [Primary source](https://arxiv.org/abs/2606.14249v3).

[^7]: Cho et al. (2026). *SkillRet: A Large-Scale Benchmark for Skill Retrieval in LLM Agents*. [Primary source](https://arxiv.org/abs/2605.05726v3).

[^8]: Gemma Team (2026). *Gemma 4 Technical Report*. [Primary source](https://arxiv.org/abs/2607.02770v2).

[^9]: Google DeepMind (2026). *Gemini 3.5 Flash model card*. [Primary source](https://deepmind.google/models/model-cards/gemini-3-5-flash/).

[^10]: He et al. (2026). *LiveMathematicianBench: A Live Benchmark for Mathematician-Level Reasoning with Proof Sketches*. [Primary source](https://arxiv.org/abs/2604.01754v1).

[^11]: Jackson et al. (2025). *AA-Omniscience: Evaluating Cross-Domain Knowledge Reliability in Large Language Models*. [Primary source](https://arxiv.org/abs/2511.13029v1).

[^12]: Jiang et al. (2026). *SoK: Agentic Skills -- Beyond Tool Use in LLM Agents*. [Primary source](https://arxiv.org/abs/2602.20867v1).

[^13]: Karpathy (2026). *LLM Wiki*. [Primary source](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

[^14]: Kwon et al. (2023). *Efficient Memory Management for Large Language Model Serving with PagedAttention*. [Primary source](https://arxiv.org/abs/2309.06180v1).

[^15]: Lee et al. (2026). *Meta-Harness: End-to-End Optimization of Model Harnesses*. [Primary source](https://arxiv.org/abs/2603.28052v1).

[^16]: Li et al. (2026). *SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks*. [Primary source](https://arxiv.org/abs/2602.12670v4).

[^17]: Liang et al. (2026). *SkillNet: Create, Evaluate, and Connect AI Skills*. [Primary source](https://arxiv.org/abs/2603.04448v3).

[^18]: Lin et al. (2026). *Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses*. [Primary source](https://arxiv.org/abs/2604.25850v4).

[^19]: Liu et al. (2026). *How Well Do Agentic Skills Work in the Wild: Benchmarking LLM Skill Usage in Realistic Settings*. [Primary source](https://arxiv.org/abs/2604.04323v1).

[^20]: Lou et al. (2026). *AutoHarness: improving LLM agents by automatically synthesizing a code harness*. [Primary source](https://arxiv.org/abs/2603.03329v1).

[^21]: Lu et al. (2026). *SKILL0: In-Context Agentic Reinforcement Learning for Skill Internalization*. [Primary source](https://arxiv.org/abs/2604.02268v2).

[^22]: Ma et al. (2024). *SpreadsheetBench: Towards Challenging Real World Spreadsheet Manipulation*. [Primary source](https://arxiv.org/abs/2406.14991v2).

[^23]: Merrill et al. (2026). *Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces*. [Primary source](https://arxiv.org/abs/2601.11868v1).

[^24]: Ni et al. (2026). *Trace2Skill: Distill Trajectory-Local Lessons into Transferable Agent Skills*. [Primary source](https://arxiv.org/abs/2603.25158v5).

[^25]: Ouyang et al. (2026). *SkillOS: Learning Skill Curation for Self-Evolving Agents*. [Primary source](https://arxiv.org/abs/2605.06614v1).

[^26]: Patwardhan et al. (2026). *GDPval: Evaluating AI Model Performance on Real-World Economically Valuable Tasks*. [Primary source](https://arxiv.org/abs/2510.04374v1).

[^27]: Pham et al. (2026). *SealQA: Raising the Bar for Reasoning in Search-Augmented Language Models*. [Primary source](https://arxiv.org/abs/2506.01062v4).

[^28]: Phan et al. (2026). *A benchmark of expert-level academic questions to assess AI capabilities (Humanity’s Last Exam)*. [Primary source](https://dx.doi.org/10.1038/s41586-025-09962-4).

[^29]: Qwen Team (2026a). *Qwen3.5: Towards native multimodal agents*. [Primary source](https://qwen.ai/blog?id=qwen3.5).

[^30]: Qwen Team (2026b). *Qwen3.6-27B*. [Primary source](https://qwen.ai/blog?id=qwen3.6-27b).

[^31]: Shi et al. (2026). *Skill1: Unified Evolution of Skill-Augmented Agents via Reinforcement Learning*. [Primary source](https://arxiv.org/abs/2605.06130v3).

[^32]: Shridhar et al. (2021). *ALFWorld: Aligning Text and Embodied Environments for Interactive Learning*. [Primary source](https://arxiv.org/abs/2010.03768v2).

[^33]: Singhvi et al. (2025). *OfficeQA*. [Primary source](https://www.databricks.com/blog/introducing-officeqa-benchmark-end-to-end-grounded-reasoning).

[^34]: Su et al. (2026). *Skill Retrieval Augmentation for Agentic AI*. [Primary source](https://arxiv.org/abs/2604.24594v3).

[^35]: Wang et al. (2026). *SkillGrad: Optimizing Agent Skills Like Gradient Descent*. [Primary source](https://arxiv.org/abs/2605.27760v1).

[^36]: Xia et al. (2026a). *SkillRL: Evolving Agents via Recursive Skill-Augmented Reinforcement Learning*. [Primary source](https://arxiv.org/abs/2602.08234v1).

[^37]: Xia et al. (2026b). *MetaClaw: Just Talk -- An Agent That Meta-Learns and Evolves in the Wild*. [Primary source](https://arxiv.org/abs/2603.17187v1).

[^38]: Xu and Yan (2026). *Agent Skills for Large Language Models: Architecture, Acquisition, Security, and the Path Forward*. [Primary source](https://arxiv.org/abs/2602.12430v4).

[^39]: Yang et al. (2026). *SkillOpt: Executive Strategy for Self-Evolving Agent Skills*. [Primary source](https://arxiv.org/abs/2605.23904v2).

[^40]: Yao et al. (2023). *ReAct: Synergizing Reasoning and Acting in Language Models*. [Primary source](https://arxiv.org/abs/2210.03629v3).

[^41]: Ye et al. (2026). *Meta Context Engineering via Agentic Skill Evolution*. [Primary source](https://arxiv.org/abs/2601.21557v2).

[^42]: Yuksekgonul et al. (2025). *Optimizing generative AI by backpropagating language model feedback (TextGrad)*. [Published article](https://www.nature.com/articles/s41586-025-08661-4); [inspected preprint, titled TextGrad: Automatic Differentiation via Text](https://arxiv.org/abs/2406.07496v1).

[^43]: Zhang et al. (2025). *Equipping agents for the real world with Agent Skills*. [Primary source](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).

[^44]: Zhang et al. (2026a). *Self-Harness: Harnesses That Improve Themselves*. [Primary source](https://arxiv.org/abs/2606.09498v3).

[^45]: Zhang et al. (2026b). *CoEvoSkills: Self-Evolving Agent Skills via Co-Evolutionary Verification*. [Primary source](https://arxiv.org/abs/2604.01687v3).

[^46]: Zheng et al. (2026). *SkillRouter: Skill Routing for LLM Agents at Scale*. [Primary source](https://arxiv.org/abs/2603.22455v5).

[^47]: Zhou et al. (2026). *Memento-Skills: Let Agents Design Agents*. [Primary source](https://arxiv.org/abs/2603.18743v1).

[^48]: Shinn et al. (2023). *Reflexion: Language Agents with Verbal Reinforcement Learning*. [Primary source](https://arxiv.org/abs/2303.11366v4).

[^49]: Madaan et al. (2023). *Self-Refine: Iterative Refinement with Self-Feedback*. [Primary source](https://arxiv.org/abs/2303.17651v2).

[^50]: Wang et al. (2023). *Voyager: An Open-Ended Embodied Agent with Large Language Models*. [Primary source](https://arxiv.org/abs/2305.16291v2).

[^51]: Hu et al. (2024). *Automated Design of Agentic Systems*. [Primary source](https://arxiv.org/abs/2408.08435v2).

[^52]: Zhang et al. (2025). *AFlow: Automating Agentic Workflow Generation*. [Primary source](https://arxiv.org/abs/2410.10762v4).

[^53]: Zhang et al. (2025). *Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents*. [Primary source](https://arxiv.org/abs/2505.22954v3).

[^54]: Novikov et al. (2025). *AlphaEvolve: A coding agent for scientific and algorithmic discovery*. [Primary source](https://arxiv.org/abs/2506.13131v1).

[^55]: Zhang et al. (2025). *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models*. [Primary source](https://arxiv.org/abs/2510.04618v3).

[^56]: Ouyang et al. (2025). *ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory*. [Primary source](https://arxiv.org/abs/2509.25140v2).

[^57]: Mouret and Clune (2015). *Illuminating search spaces by mapping elites*. [Primary source](https://arxiv.org/abs/1504.04909v1).

[^58]: Wang et al. (2019). *Paired Open-Ended Trailblazer (POET): Endlessly Generating Increasingly Complex and Diverse Learning Environments and Their Solutions*. [Primary source](https://arxiv.org/abs/1901.01753v3).

[^59]: Romera-Paredes et al. (2023/2024). *Mathematical discoveries from program search with large language models*. [Primary source](https://www.nature.com/articles/s41586-023-06924-6).

[^60]: Khattab et al. (2023). *DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines*. [Primary source](https://arxiv.org/abs/2310.03714v1).
