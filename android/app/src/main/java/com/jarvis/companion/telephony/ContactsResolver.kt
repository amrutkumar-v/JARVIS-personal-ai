package com.jarvis.companion.telephony

import android.content.Context
import android.provider.ContactsContract

/**
 * Real contacts lookup on the phone — the ONLY way a contact NAME becomes a
 * dialable number, because ACTION_CALL needs a number.
 *
 * Requires `READ_CONTACTS`. Without it, `PermissionRequired` is returned so the
 * caller can fail honestly with PERMISSION_REQUIRED instead of dialling a
 * guessed number. No contacts are ever copied to JARVIS Core: only the single
 * name/number pair needed for the call is read, transiently.
 */
object ContactsResolver {

    sealed class ContactLookup {
        data class Found(val name: String, val number: String) : ContactLookup()
        object NotFound : ContactLookup()
        object PermissionRequired : ContactLookup()
        object Unavailable : ContactLookup()
    }

    private const val MAX_QUERY_CHARS = 60

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
            var fallback: ContactLookup.Found? = null
            context.contentResolver
                .query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, projection, selection, arrayOf("%$escaped%"), null)
                ?.use { cursor ->
                    val nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                    val numberIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                    if (nameIndex < 0 || numberIndex < 0) return ContactLookup.Unavailable
                    while (cursor.moveToNext()) {
                        val name = cursor.getString(nameIndex) ?: continue
                        val number = TelephonyCapability.normalizeNumber(cursor.getString(numberIndex) ?: continue) ?: continue
                        // Prefer an exact (case-insensitive) name match; otherwise
                        // remember the first partial match and keep looking.
                        if (name.equals(query, ignoreCase = true)) return ContactLookup.Found(name, number)
                        if (fallback == null) fallback = ContactLookup.Found(name, number)
                    }
                }
            fallback ?: ContactLookup.NotFound
        } catch (e: SecurityException) {
            ContactLookup.PermissionRequired
        } catch (t: Throwable) {
            ContactLookup.Unavailable
        }
    }
}
