# Mutation Principles for Test Writing

Reference companion for `write-tests`. Load when writing or reviewing tests.

## Why mutation thinking matters

A test suite's value isn't line coverage — it's **failure detection**. A test that still passes when you break the code it's supposed to protect is worthless. Stryker, mutmut, and go-mutesting formalise this by injecting small code changes ("mutants") and measuring how many the test suite catches. `write-tests` doesn't run a mutation tool at write-time; it internalises the operator list so tests are born catch-ready.

The question you ask for every test you write:

> If a hostile refactor flipped one thing in the code I'm testing, would this test still pass?

If yes, the test is lying.

## The operator taxonomy

Stryker (JS/TS) uses these; mutmut (Python), go-mutesting (Go), pitest (Java), mull (C/C++) all use close analogues. When you mentally pre-check your test against mutations, use this list.

### 1. Arithmetic operator replacement

```
+ → - → * → / → %
```

**Case:** `function discount(price, rate) { return price * (1 - rate); }`.

**Bad test** — passes under `*` → `/`:
```ts
expect(discount(100, 0.1)).toBeGreaterThan(0); // true for both cases
```

**Good test** — fails under `*` → `/`:
```ts
expect(discount(100, 0.1)).toBe(90);
```

Assert exact numeric outcomes. Truthiness assertions are blind to arithmetic drift.

### 2. Relational / boundary

```
< → <= → > → >=
== → !=
```

**Case:** `if (age < 18) return 'minor';`.

**Bad test** — passes under `<` → `<=`:
```ts
expect(classify(17)).toBe('minor');
expect(classify(25)).toBe('adult');
```

**Good test** — fails under `<` → `<=` (the 18-year-old is now wrongly classified):
```ts
expect(classify(17)).toBe('minor');
expect(classify(18)).toBe('adult');   // the boundary
expect(classify(25)).toBe('adult');
```

Always test the **exact** boundary and at least one value on each side.

### 3. Logical connector

```
&& → ||
|| → &&
!x → x
```

**Case:** `if (user.verified && user.active) return allow();`.

**Bad test** — passes under `&&` → `||`:
```ts
expect(gate({verified: true, active: true})).toBe('allow');
```

**Good test** — fails under the flip:
```ts
expect(gate({verified: true, active: true})).toBe('allow');
expect(gate({verified: true, active: false})).toBe('deny');   // catches &&→||
expect(gate({verified: false, active: true})).toBe('deny');   // catches &&→||
expect(gate({verified: false, active: false})).toBe('deny');
```

Every branch of a compound condition needs at least one covering case.

### 4. Conditional inversion

```
if (x) → if (!x)
if (x) → if (true)
if (x) → if (false)
```

**Case:** `if (input.trim() === '') return 'error'; return ok(input);`.

**Bad test** — passes under `if (x)` → `if (false)`:
```ts
expect(handle('hello')).toBe(ok('hello'));
```

**Good test** — exercises BOTH branches:
```ts
expect(handle('')).toBe('error');
expect(handle('   ')).toBe('error');
expect(handle('hello')).toBe(ok('hello'));
```

Every `if` needs a test that takes the TRUE path AND one that takes the FALSE path.

### 5. Return value

```
return x → return
return x → return null
return true → return false
```

**Case:** `function isAdmin(user) { return user.roles.includes('admin'); }`.

**Bad test** — passes under `return true → return false` because both tests read the same (wrong) value:
```ts
expect(isAdmin(guest)).toBeTruthy();  // guest isn't admin, "truthy" is wrong here anyway
```

**Good test** — fails under any return-value mutation:
```ts
expect(isAdmin(admin)).toBe(true);
expect(isAdmin(guest)).toBe(false);
```

Assert on the exact return value with `.toBe(true)` / `.toBe(false)` / `.toStrictEqual(expected)`. `.toBeTruthy()` / `.toBeDefined()` are too permissive.

### 6. Unary operator replacement

```
-x → +x → x
++x → --x
```

**Case:** `function absDiff(a, b) { return Math.abs(a - b); }`.

Test with inputs where `a - b < 0` AND where `a - b > 0`. If both tests survive `-b → +b`, add one that wouldn't (e.g. `absDiff(0, 5) === 5`).

### 7. Assignment replacement

```
x = y → x = 0
x += y → x = y
```

Tests that pass for both the cumulative and the first-write-wins version are blind. Assert the *state after N operations*, not just after one.

### 8. Literal replacement

```
"error" → ""
"success" → "error"
42 → 0
[1,2,3] → []
```

**Case:** `if (result.status !== 'ok') throw new Error('failure');`.

Tests that only assert `toThrow()` pass under the string change. Use `.toThrow('failure')` / `expect(error.message).toBe('failure')` when the error message carries semantics.

### 9. Early-exit / statement removal

```
early return removed
throw removed
await removed
```

**Case:**
```ts
async function send(msg) {
  if (!msg) throw new Error('msg required');
  await queue.push(msg);
  return { status: 'sent' };
}
```

**Bad test** — passes even if the `throw` is removed:
```ts
expect(await send('hello')).toEqual({ status: 'sent' });
```

**Good test** — fails when the `throw` is removed (catches "silent success on bad input"):
```ts
expect(await send('hello')).toEqual({ status: 'sent' });
await expect(send('')).rejects.toThrow('msg required');
expect(queue.push).not.toHaveBeenCalledWith('');   // catches "no-op on bad input"
```

Assert that side effects **don't happen** in the negative cases, not just that no error is thrown.

## Anti-patterns (rewrite, don't ship)

### Testing the mock

```ts
// BAD
render(<Page />);
expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
```

You're testing that the mock renders. Either unmock the sidebar, or assert on *Page*'s behaviour in the presence of a rendered sidebar.

### Test-only methods in production classes

Adding `Session.destroy()` / `Repo.reset()` / `Config.__setMock()` to production code "for tests" pollutes the public API and risks accidental calls in prod. Put cleanup in test utilities.

### Partial mocks

Mocking half of a response struct and trusting the code-under-test only reads the half you included. Downstream code that reads an omitted field will fail silently. Mirror the real API completely.

### Over-mocking

Mocking the thing whose side effect the test depends on. Example: test asserts `addServer` detects duplicates by checking config state, but you mocked the config writer — so there's no state to detect against, and the test passes for the wrong reason.

### Tautological assertions

```ts
expect(double(x)).toBe(double(x));   // passes for any implementation of double
```

Compute the expected value independently (`expect(double(3)).toBe(6)`), ideally via a different mental model than the implementation.

### Missing error path

A function that `throw`s or returns an error result is only fully tested when both the success path AND every error path have cases. Error cases are the single most common coverage gap.

### Snapshot-only tests

```ts
expect(renderResult).toMatchSnapshot();
```

Snapshots catch drift but not correctness. They're fine as a *supplement*; not as the *only* assertion on a component. Every component still needs behavioural tests for its interactive surface.

## Heuristics for test count

For a typical pure function with one `if`, two branches, and a boundary: **3 tests** (true branch, false branch, boundary).

For a class / module with N public methods and average 2 branches each: roughly `2N + N_edge_cases` tests. Don't pad beyond what the mutation checklist justifies.

## When to stop

You've done enough when:

- Every exported function / method has at least one test.
- Every `if` / `match` branch has at least one test.
- Every throw / raise / error-return has at least one test.
- Every loop has tests at length 0, 1, N, and N+1 inputs (only where N matters).
- Running through the 9 operators above, you can identify at least one existing test that would fail under each mutation.

Stopping sooner leaves mutations uncovered. Going further wastes time on tests that the first N already catch.

## Recommended reading (external)

- Stryker (JS/TS): https://stryker-mutator.io/
- mutmut (Python): https://mutmut.readthedocs.io/
- go-mutesting (Go): https://github.com/zimmski/go-mutesting
- pitest (Java): https://pitest.org/
- "Write tests that catch bugs, not lines" — the mutation-testing pitch in one sentence.
