// Every modal submit handler the bot has, in one place.
// Mirrors composition/commands.ts: metadata declared here, implementation
// behind a lazy `load()`.

import { ModalRegistry, defineModal } from "../presentation/framework/modal-registry.ts";

export function buildModalRegistry(): ModalRegistry {
  return new ModalRegistry().register(
    defineModal(
      { customId: "modal:verify-identity" },
      async () =>
        new (await import("../presentation/modals/onboarding/carbon-identity.modal.ts")).CarbonIdentityModal(),
    ),
    defineModal(
      { customId: "modal:ticket-create" },
      async () =>
        new (await import("../presentation/modals/ticketing/ticket-create.modal.ts")).TicketCreateModal(),
    ),
    defineModal(
      { customId: "modal:suggest-create" },
      async () =>
        new (await import("../presentation/modals/community/suggest-create.modal.ts")).SuggestCreateModal(),
    ),
    defineModal(
      { customId: "modal:issue-create" },
      async () =>
        new (await import("../presentation/modals/community/issue-create.modal.ts")).IssueCreateModal(),
    ),
  );
}
