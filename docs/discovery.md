# Agent discovery

The homepage is one control: **Tell your agent**, with a Copy button for the one line. The same instructions are in the page source, `Accept: text/markdown`, `/llms.txt`, and `/skills/click/SKILL.md`.

Discovery documents live at `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` (and the `/mcp` suffix), `/.well-known/api-catalog`, `/.well-known/mcp/server-card.json`, `/.well-known/agent-card.json`, `/.well-known/agent-skills/index.json`, and `/.well-known/ai-catalog.json`. `/auth.md` describes registration.

Commerce checks (x402, MPP, UCP, ACP, AP2) are intentionally skipped because Click does not take payment. DNS-AID records are not created by `wrangler deploy`; add them on the zone if a scanner requires `_agents` SVCB. Web Bot Auth is not implemented; that check is informational on isitagentready.com. A brand-new domain will not rank for its own name until it is indexed, which one Is Agentic recommended check measures and this repo cannot force.
