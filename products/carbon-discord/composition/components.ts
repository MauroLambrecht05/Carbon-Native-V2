// Every message component handler (button, select menu) the bot has, in one place.
// Mirrors composition/commands.ts: metadata declared here, implementation
// behind a lazy `load()`.

import { ComponentRegistry, defineComponent } from "../presentation/framework/component-registry.ts";

export function buildComponentRegistry(): ComponentRegistry {
  return new ComponentRegistry().register(
    defineComponent(
      { customId: "verify:rules" },
      async () =>
        new (await import("../presentation/components/onboarding/verify-rules.component.ts")).VerifyRulesComponent(),
    ),
    defineComponent(
      { customId: "verify:identity-prompt" },
      async () =>
        new (await import(
          "../presentation/components/onboarding/verify-identity-button.component.ts"
        )).VerifyIdentityButtonComponent(),
    ),
    defineComponent(
      { customId: "ticket:open" },
      async () =>
        new (await import(
          "../presentation/components/ticketing/ticket-open-button.component.ts"
        )).TicketOpenButtonComponent(),
    ),
    defineComponent(
      { customId: "ticket:claim" },
      async () =>
        new (await import(
          "../presentation/components/ticketing/ticket-claim.component.ts"
        )).TicketClaimComponent(),
    ),
    defineComponent(
      { customId: "ticket:close" },
      async () =>
        new (await import(
          "../presentation/components/ticketing/ticket-close.component.ts"
        )).TicketCloseComponent(),
    ),
    defineComponent(
      { customId: "ticket:transcript" },
      async () =>
        new (await import(
          "../presentation/components/ticketing/ticket-transcript.component.ts"
        )).TicketTranscriptComponent(),
    ),
    defineComponent(
      { customId: "suggest:vote:", isPrefix: true },
      async () =>
        new (await import(
          "../presentation/components/community/suggest-vote.component.ts"
        )).SuggestVoteComponent(),
    ),
    defineComponent(
      { customId: "issue:", isPrefix: true },
      async () =>
        new (await import(
          "../presentation/components/community/issue-actions.component.ts"
        )).IssueActionsComponent(),
    ),
    defineComponent(
      { customId: "event:rsvp:", isPrefix: true },
      async () =>
        new (await import(
          "../presentation/components/community/event-rsvp.component.ts"
        )).EventRsvpComponent(),
    ),
    defineComponent(
      { customId: "role:toggle:", isPrefix: true },
      async () =>
        new (await import(
          "../presentation/components/community/role-toggle.component.ts"
        )).RoleToggleComponent(),
    ),
    defineComponent(
      { customId: "thread:resolve" },
      async () =>
        new (await import(
          "../presentation/components/community/resolve-thread.component.ts"
        )).ResolveThreadComponent(),
    ),
  );
}
