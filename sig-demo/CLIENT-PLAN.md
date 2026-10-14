# Desktop account creation

The initial `sig demo` client preserves Signal Desktop's conversation, encrypted
messaging, and Groups V2 UI. Its private onboarding asks for an invitation and
display name. It never asks for a real phone number, SMS code, linked phone, or
production credentials.

The client generates fresh ACI and PNI identity keys, signed prekeys, Kyber
prekeys, account entropy, and profile keys locally. Only public keys go to
`POST /v1/sig-demo/accounts`, along with the invitation and a newly generated
device authentication secret. The private server assigns an internal synthetic
E164 identifier for compatibility with the existing test server. This identifier
is not a user's telephone number and is never verified by SMS. Therefore this
milestone is phone-free for users, but not yet an entirely numberless internal
protocol. Replacing the internal number/PNI is later work.

The endpoint uses the existing registration JSON schema plus `inviteCode`,
`displayName`, and top-level `password`. It returns the usual ACI/PNI account
identifiers, the synthetic `number`, `deviceId: 1`, and `storageCapable: false`.
Exact retries must be idempotent; different credentials cannot reuse a redeemed
invitation.

Before redeeming an invitation, the client durably stores the complete pending
registration material inside its existing SQLCipher database. Retries reuse all
identity/prekey records, account/profile keys, authentication and recovery
passwords, registration IDs, and the original invitation/name. An interrupted
setup resumes after restart without re-entering the invitation. The draft stays
until the account keys are committed and the profile upload is durably queued;
then it is removed. Definitively rejected invitations can be corrected without
reusing a redeemed request. Private keys are never written to plaintext files.

The normal SMS/captcha registration API is not used by this flow. Signup checks
`sigDemoEnabled` and the localhost TLS configuration before generating or
replacing account data. The desktop keeps libsignal's local test transport; an
optional loopback TCP relay forwards opaque TLS to the approved private VPS,
allowing friends on different computers to use the same demo backend.

Desktop already implements group creation and administration. Its group creator
adds the local ACI as an administrator, fetches group credentials and profile key
credentials, and uses the Groups V2 storage API. Those existing paths must be
tested against the private server with two real desktop clients. Desktop-only
signup by itself does not establish that groups or persistent messaging work.

An authenticated `GET /v1/sig-demo/directory` returns
`{ accounts: [{ uuid, displayName }] }`. The client imports these participants as
contacts when its authenticated connection opens, then refreshes every 30
seconds. Joining this closed demo opts participants into profile sharing with
the other invitees. Each new contact receives the normal encrypted Signal
profile-key update; the directory never carries profile keys. Until both
clients exchange their updates, upstream group creation can add a participant
as a pending member. Existing block settings still govern message sends.

The launcher uses isolated demo profiles. Production Signal databases and
credentials are never copied into the demo.
