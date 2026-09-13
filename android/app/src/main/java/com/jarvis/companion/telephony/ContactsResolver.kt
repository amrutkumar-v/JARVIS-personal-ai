package com.jarvis.companion.telephony

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.ContactsContract
import com.jarvis.companion.model.ContactItem

object ContactsResolver {

    /**
     * Resolves a phone number to a contact name from the Android Contacts Provider.
     */
    fun resolveContactName(context: Context, phoneNumber: String): String? {
        if (phoneNumber.isBlank()) return null
        val uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
            Uri.encode(phoneNumber)
        )
        val projection = arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME)
        var contactName: String? = null

        try {
            val cursor: Cursor? = context.contentResolver.query(uri, projection, null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    val nameIndex = it.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME)
                    if (nameIndex != -1) {
                        contactName = it.getString(nameIndex)
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        return contactName
    }

    /**
     * Searches contacts matching a query string (name or number) or returns all contacts up to limit.
     */
    fun searchContacts(context: Context, query: String = "", limit: Int = 100): List<ContactItem> {
        val contacts = mutableListOf<ContactItem>()
        val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.STARRED
        )

        var selection: String? = null
        var selectionArgs: Array<String>? = null
        if (query.isNotBlank()) {
            selection = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ? OR ${ContactsContract.CommonDataKinds.Phone.NUMBER} LIKE ?"
            val wildcard = "%$query%"
            selectionArgs = arrayOf(wildcard, wildcard)
        }

        val sortOrder = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"

        try {
            val cursor: Cursor? = context.contentResolver.query(
                uri,
                projection,
                selection,
                selectionArgs,
                sortOrder
            )
            cursor?.use {
                val idIdx = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
                val nameIdx = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numberIdx = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                val starIdx = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.STARRED)

                while (it.moveToNext() && contacts.size < limit) {
                    val id = if (idIdx != -1) it.getString(idIdx) else ""
                    val name = if (nameIdx != -1) it.getString(nameIdx) else "Unknown"
                    val number = if (numberIdx != -1) it.getString(numberIdx) else ""
                    val starred = if (starIdx != -1) it.getInt(starIdx) == 1 else false

                    contacts.add(ContactItem(id, name, number, starred))
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        return contacts
    }
}
