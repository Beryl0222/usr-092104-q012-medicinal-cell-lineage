export const REQUIRED_TRANSFER_TERMS = ["purpose", "term_end", "attribution", "redistribution_allowed"];

/** 转移投影：对外转移协议及其撤回。 */
export class TransferIndex {
  constructor() {
    this.agreements = new Map();
  }

  apply(event) {
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "TRANSFER_APPROVED":
        this.agreements.set(event.aggregate_id, {
          agreement_id: event.aggregate_id,
          material_id: payload.material_id,
          from_team: payload.from_team,
          to_holder: payload.to_holder,
          custodian: payload.custodian,
          purpose: payload.purpose,
          term_end: payload.term_end,
          attribution: payload.attribution,
          redistribution_allowed: payload.redistribution_allowed,
          status: "active",
          approved_at: event.occurred_at,
        });
        break;
      case "TRANSFER_WITHDRAWN": {
        const agreement = this.agreements.get(event.aggregate_id);
        if (agreement) {
          agreement.status = "withdrawn";
          agreement.withdrawal_reason = payload.reason;
          agreement.withdrawn_at = event.occurred_at;
        }
        break;
      }
      default:
        break;
    }
  }

  getAgreement(agreementId) {
    const agreement = this.agreements.get(agreementId);
    return agreement ? structuredClone(agreement) : undefined;
  }

  /** 某材料全部有效的下游持有方（含经允许的再分发链）。 */
  holdersOf(materialId, fromHolders) {
    const holders = new Set(fromHolders);
    let grew = true;
    while (grew) {
      grew = false;
      for (const agreement of this.agreements.values()) {
        if (agreement.material_id !== materialId) continue;
        if (holders.has(agreement.from_team) && !holders.has(agreement.to_holder)) {
          holders.add(agreement.to_holder);
          grew = true;
        }
      }
    }
    return holders;
  }
}
