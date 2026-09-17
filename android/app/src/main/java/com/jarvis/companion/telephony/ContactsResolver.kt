package com.jarvis.companion.telephony

import android.content.Context
import android.provider.ContactsContract

/**
 * Real contacts lookup on the phone — the ONLY way a contact NAME becomes a
 * dialable number, because ACTION_CALL needs a number.
 *
 * Requires `READ_CONTACTS`. Without it, `PermissionRequired` is returned so the
 * caller can fail honestly with PERMISSION_REQUIRED instead of dialling a
 * guessed number. No contacts are ever copied to JARVIS Core: only the
 * name/number pairs needed to answer the request are read, transiently.
 *
 * JARVIS never guesses WHICH contact the user meant: an exact (case-insensitive)
 * name wins, a single partial match is unambiguous, and several partial matches
 * are reported as `Ambiguous` so the caller can ASK instead of dialling.
 */
object ContactsResolver {

    /** One resolved contact row. */
    data class Candidate(val name: String, val number: String)

    sealed class ContactLookup {
        data class Found(val name: String, val number: String) : ContactLookup()

        /**
         * No exact match and more than one partial match. The caller must ask the
         * user which contact to call — dialling any of them would be a guess.
         */
        data class Ambiguous(val query: String, val candidates: List<Candidate>) : ContactLookup()

        object NotFound : ContactLookup()
        object PermissionRequired : ContactLookup()
        object Unavailable : ContactLookup()
    }

    private const val MAX_QUERY_CHARS = 60

    /** Candidates reported back when a name is ambiguous (bounded payload). */
    const val MAX_CANDIDATES = 5

    /**
     * The matching POLICY, isolated so it is unit-testable without an Android
     * runtime: an exact name wins, exactly one partial match is used, several
     * partial matches are AMBIGUOUS, none is `NotFound`.
     */
    fun decide(query: String, matches: List<Candidate>): ContactLookup {
        if (query.isBlank()) return ContactLookup.NotFound
        val exact = matches.firstOrNull { it.name.equals(query, ignoreCase = true) }
        if (exact != null) return ContactLookup.Found(exact.name, exact.number)
        // Two rows that differ only by formatting are ONE choice, not two.
        val distinct = matches.distinctBy { it.name.lowercase() to it.number }.take(MAX_CANDIDATES)
        return when (distinct.size) {
            0 -> ContactLookup.NotFound
            1 -> ContactLookup.Found(distinct[0].name, distinct[0].number)
            else -> ContactLookup.Ambiguous(query, distinct)
        }
    }

    fun findNumber(context: Context, rawQuery: String): ContactLookup {
        val query = rawQuery.trim().take(MAX_QUERY_CHARS)
        if (query.isEmpty()) return ContactLookup.NotFound
        if (!TelephonyCapability.canReadContacts(context)) return ContactLookup.PermissionRequired

        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
        )
        val escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        val selection = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ? ESCAPE '\\'"
        return try {
            val collected = mutableListOf<Candidate>()
            context.contentResolver
                .query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, projection, selection, arrayOf("%$escaped%"), null)
                ?.use { cursor ->
                    val nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                    val numberIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                    if (nameIndex < 0 || numberIndex < 0) return ContactLookup.Unavailable
                    while (cursor.moveToNext()) {
                        val name = cursor.getString(nameIndex) ?: continue
                        val number = TelephonyCapability.normalizeNumber(cursor.getString(numberIndex) ?: continue) ?: continue
                        if (name.equals(query, ignoreCase = true)) {
                            // An exact name is unambiguous — it wins immediately.
                            return ContactLookup.Found(name, number)
                        }
                        if (collected.size < MAX_CANDIDATES) collected += Candidate(name, number)
                    }
                }
            decide(query, collected)
        } catch (e: SecurityException) {
            ContactLookup.PermissionRequired
        } catch (t: Throwable) {
            ContactLookup.Unavailable
        }
    }
}
