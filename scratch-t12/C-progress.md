# Subagent C — T12.4 progress (READ-ONLY recon)

Deliverable: `scratch-t12/T12.4-findings.md`

## Outline (6 sections)
1. Trigger table — every `emitState("disconnected")` in dsh-client-connection
2. Which UI element shows "disconnected" (component / i18n / location)
3. Bridge-down impact matrix (extension vs GUI iframe)
4. Design recommendation for wave-2 implementer D (panel.js + sw.js only)
5. Live snapshot (curl :3081/health, :3080, timestamps)
6. Open questions

## Plan
- [x] Read brief-C.md
- [x] Create C-progress.md
- [ ] Locate dsh client bundle tree (dsh-client-connection, dsh-client-ui-settings-general, dsh-cordis-client-runner, locale pkg)
- [ ] Read client.js state machine; build trigger table for ALL emit sites
- [ ] Read index.js auth gate (L380–430)
- [ ] Find indicator rendering + where it displays (grep connectionIndicator / disconnectedLabel / connection.error)
- [ ] Read extension/sw.js + bridge/bridge.mjs; confirm GUI iframe never needs bridge
- [ ] Read CP-3.5.md §2 + §9
- [ ] Run live curls, record snapshot
- [ ] Write T12.4-findings.md sections 1–6 incrementally
- [ ] Final: send_message to parent, report checklist

## Status
NOT STARTED (reading bundle tree)
