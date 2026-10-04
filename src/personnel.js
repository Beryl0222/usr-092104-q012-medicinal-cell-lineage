/** 人员投影：资料授权、回收与离岗。 */
export class PersonnelIndex {
  constructor() {
    this.persons = new Map();
  }

  apply(event) {
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "PERSONNEL_AUTHORIZED":
        this.#person(event.aggregate_id).authorizations.set(payload.scope, {
          scope: payload.scope,
          resource: payload.resource,
          granted_at: event.occurred_at,
        });
        break;
      case "PERSONNEL_AUTHORIZATION_REVOKED":
        this.#person(event.aggregate_id).authorizations.delete(payload.scope);
        break;
      case "PERSONNEL_OFFBOARDED":
        this.#person(event.aggregate_id).offboarded = true;
        break;
      default:
        break;
    }
  }

  #person(personId) {
    if (!this.persons.has(personId)) {
      this.persons.set(personId, { person_id: personId, authorizations: new Map(), offboarded: false });
    }
    return this.persons.get(personId);
  }

  activeAuthorizations(personId) {
    const person = this.persons.get(personId);
    if (!person || person.offboarded) return [];
    return [...person.authorizations.values()].map((entry) => ({ ...entry }));
  }

  hasAccess(personId, scope) {
    const person = this.persons.get(personId);
    return Boolean(person && !person.offboarded && person.authorizations.has(scope));
  }

  isOffboarded(personId) {
    return Boolean(this.persons.get(personId)?.offboarded);
  }
}
