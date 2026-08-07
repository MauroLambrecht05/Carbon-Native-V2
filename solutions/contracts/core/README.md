# core

Primitives every other contract builds on: `Vec3`, `Transform`, `MemoryBuffer`,
`TaskHeader`.

**Agreement** wire (`schema/core.fbs`) · **Honoured by** every language
**Breaking it** cascades — every other wire contract embeds these, so a change
here touches all of them. The most conservative subject in the tier.
