# SERP Monitor

`/serp-monitor` watches whole top-100 SERPs per market (engine · country · language · device + a
keyword set), snapshots every run, and reports host-level changes, volatility and "storms" against
the project's own baseline — plus a domain catalogue (first seen, registration age, DR).
Source in v1 is the user's own A-Parser (`SE::Google`), so there is no per-request cost.

This page is a stub; the full documentation lands with the module (see `docs/tasks/serp-monitor/`
for the plan and `docs/tasks/serp-monitor/CONTRACT.md` for the data model and API).
