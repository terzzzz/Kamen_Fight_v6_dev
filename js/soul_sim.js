// BEFORE (Missing category metadata):
if (pending.length > 0) {
  const nextEnv = E.create(state, previousActions);
  ...
  for (let i = 0; i < pending.length; i++) {
    yield {
      type: "transition",
      transition: {
        s: pending[i].s,
        a: pending[i].a,
        m: pending[i].m,
        s1,
        m1,
        r: roundReward / pending.length,
        discount,
        done: isMatchDone,
        demo: pending[i].demo,
        isFinalRoundResolution: isLastInRound,
        actionKey: resolvedMove,
        resolvedActionKey: resolvedMove
      }
    };
  }
}
