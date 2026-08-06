---
id: research
version: 1
description: Conduct deep, source-diverse research through discovery, evidence extraction, contradiction testing, targeted follow-up, and independently reviewed synthesis
invocation: both
requires_tools: [web.search, web.fetch, agent.run, fs.read_text, fs.write_text, fs.create_directory]
---
# Research

Treat research as an evidence pipeline, not a single search or a summary of headlines. The current conversation and any request supplied with the invocation define the question.

## 1. Define the research contract

Clarify the decision or question, scope, freshness requirement, jurisdiction or audience, desired depth, and output form. Record `.research/plan.md` with:

- the primary question and useful subquestions;
- what evidence would support, weaken, or change the conclusion;
- required source classes and known gaps;
- stopping conditions and any time constraint.

Ask the user only about ambiguity that would materially change the research. Never fill a critical gap with assumed intent.

## 2. Map the evidence landscape

Use `web.search` for source discovery. Create distinct searches for relevant source classes rather than repeating one broad query. Depending on the subject these may include:

- primary documentation, standards, datasets, filings, or original research;
- official announcements and current product information;
- reputable news reporting;
- specialist analysis, engineering posts, or practitioner blogs;
- community experience from forums and Reddit;
- credible criticism, failed attempts, and contrary evidence.

Search summaries are leads, not evidence. Use `web.fetch` to read the underlying sources. Follow consequential citations and links when they can materially affect the conclusion. Do not treat duplicated reporting of one original claim as independent confirmation.

When the question can be cleanly partitioned, run bounded `general` sub-agents concurrently by subquestion or source class. Give each a compact question, freshness requirement, and evidence format. Concurrency follows NNA's discovered sub-agent capacity.

## 3. Build an evidence ledger

Record material claims in `.research/evidence.md`. For each claim include:

- concise claim text;
- direct source URL and source type;
- publication date and relevant event/data date when available;
- supporting excerpt or faithful bounded paraphrase;
- whether it is fact, source assertion, inference, opinion, or anecdote;
- confidence, limitations, and conflicts;
- which other sources are genuinely independent.

Prefer primary sources for factual and current claims. Community sources are valuable evidence of experience and sentiment, but do not silently generalize anecdotes into prevalence.

## 4. Challenge the developing answer

Identify contradictions, missing stakeholders, geographic or selection bias, stale evidence, circular citations, and claims supported only by training knowledge. Run targeted follow-up searches for the strongest counterargument and unresolved high-impact gaps.

Delegate a fresh `reviewer` to inspect the research question, plan, evidence ledger, and draft conclusion. It must report unsupported claims, missing source classes, contradictory evidence, and conclusions stronger than the evidence permits. It must not manufacture sources or rewrite the conclusion.

Repair material gaps with focused retrieval. Do not continue searching merely to accumulate links. Stop when additional searching produces no material new evidence, required source classes are represented, contradictions are either resolved or explicitly preserved, and the answer can state its confidence honestly.

## 5. Synthesize transparently

Write `.research/report.md` and answer the user with:

- the direct conclusion or decision-relevant findings first;
- the strongest supporting evidence;
- meaningful disagreement and alternative explanations;
- a clear separation of verified facts, reasonable inference, opinion, and unknowns;
- dates and inline source URLs close to the claims they support;
- limitations and what new evidence could change the conclusion.

Never cite a search-results page as if it were the underlying source. Never assert that something is current, unavailable, or nonexistent based only on training data or failure to find it. If retrieval fails, state what could not be verified.
