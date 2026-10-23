# Conversations

The mail list shows conversations: a message and the replies to it, from every folder,
in one row. Viauna works them out as it indexes each message
(`server/mail/threading.ts`), from the headers mail apps put on replies, not by guessing.

## What joins a conversation

- **A reply.** Every message has a `Message-ID`; a reply names the one it answers in
  `In-Reply-To`, and the conversation so far in `References`. A message whose
  `In-Reply-To` or `References` names one already in a conversation joins it.
- **Across folders.** Your reply, filed in Sent, sits under the message it answers in the
  Inbox.
- **In any order.** A reply that arrives before the message it answers (from a slow
  server, or synced first) keeps the ids it names, so the original joins it when it comes.
- **Two branches.** When a later message names messages from two conversations, they
  become one.
- **A copy.** The same message in another folder (the same `Message-ID` from the same
  sender), such as a copy filtered elsewhere, is in the same conversation, whatever its
  subject.

## What starts a new one

- **A new subject.** A reply whose subject differs from the conversation's starts a new
  conversation, rather than being glued onto an old one. Subjects are
  compared without `Re:`, `Fwd:` and their equivalents in other languages (`AW:`, `SV:`,
  `Antw:`, `RIF:`, `Odp:` and more, with counts such as `Re[2]:`), without mailing-list
  tags such as `[team]`, and ignoring case and spacing.
- **No reply headers.** A message that names no other, as some automatic senders send, is
  a conversation of its own even with the same subject as another: nothing shows it
  answers that one.
- **A stranger's copy.** A message reusing the `Message-ID` of one of yours, from another
  sender, doesn't join or take over your conversation.

## Where it's kept

The conversations are part of the mail index (`index.db`), worked out again if it's
rebuilt. Nothing is written to your mail server: other mail apps group the same mail in
their own way.
