import { expectTypeOf, test } from "vitest";

import type { OutgoingEmail } from "../src/domain/draft.ts";
import type { SendQueueMessage } from "../src/domain/send-queue-message.ts";

// Checked by `tsc` (`pnpm build`) rather than at runtime. The schema's `satisfies
// z.ZodType<OutgoingEmail>` checks one direction only, so it misses a field the schema adds, or one
// the type adds as optional.
test("the Send Queue message's outgoing email is exactly the domain's OutgoingEmail", () => {
  expectTypeOf<SendQueueMessage["outgoingEmail"]>().toEqualTypeOf<OutgoingEmail>();
});
