package com.jarvis.companion.telephony

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure unit tests for the contact-matching POLICY that runs before any number is
 * handed to `TelecomManager` (the cursor part of `findNumber` needs Android, the
 * policy does not).
 *
 * These encode the hard rule: JARVIS may only dial a contact it is CERTAIN the
 * user meant. An exact name wins, a single partial match is unambiguous, and
 * several partial matches must be reported as ambiguous so the user is asked
 * instead of a guessed contact being called.
 */
class ContactsResolverTest {

    private fun c(name: String, number: String) = ContactsResolver.Candidate(name, number)

    @Test
    fun exactMatchWinsEvenWhenOtherPartialsExist() {
        val lookup = ContactsResolver.decide(
            "Dad",
            listOf(c("Dad's office", "5550111"), c("Dad", "5550199"), c("Daddy", "5550177")),
        )
        assertEquals(ContactsResolver.ContactLookup.Found("Dad", "5550199"), lookup)
    }

    @Test
    fun exactMatchIsCaseInsensitive() {
        val lookup = ContactsResolver.decide("dad", listOf(c("Dad", "5550199")))
        assertEquals(ContactsResolver.ContactLookup.Found("Dad", "5550199"), lookup)
    }

    @Test
    fun aSinglePartialMatchIsUnambiguous() {
        val lookup = ContactsResolver.decide("Sam", listOf(c("Samantha", "5550123")))
        assertEquals(ContactsResolver.ContactLookup.Found("Samantha", "5550123"), lookup)
    }

    @Test
    fun severalPartialMatchesAreAmbiguousAndDialNothing() {
        val lookup = ContactsResolver.decide("Sam", listOf(c("Samantha", "5550123"), c("Samuel", "5550456")))
        assertTrue("two partial matches must never resolve to a single contact", lookup is ContactsResolver.ContactLookup.Ambiguous)
        val ambiguous = lookup as ContactsResolver.ContactLookup.Ambiguous
        assertEquals("Sam", ambiguous.query)
        assertEquals(listOf("Samantha", "Samuel"), ambiguous.candidates.map { it.name })
    }

    @Test
    fun repeatedRowsForOneContactAreNotAmbiguity() {
        // The same contact saved twice (different number formatting) is ONE
        // choice, not two — otherwise JARVIS would nag about a false ambiguity.
        val lookup = ContactsResolver.decide("Sam", listOf(c("Samantha", "5550123"), c("Samantha", "5550123")))
        assertEquals(ContactsResolver.ContactLookup.Found("Samantha", "5550123"), lookup)
    }

    @Test
    fun ambiguousChoicesAreBounded() {
        val many = (1..12).map { c("Sam $it", "55501$it") }
        val lookup = ContactsResolver.decide("Sam", many)
        assertTrue(lookup is ContactsResolver.ContactLookup.Ambiguous)
        assertEquals(ContactsResolver.MAX_CANDIDATES, (lookup as ContactsResolver.ContactLookup.Ambiguous).candidates.size)
    }

    @Test
    fun noMatchIsNotFound() {
        assertEquals(ContactsResolver.ContactLookup.NotFound, ContactsResolver.decide("Nobody", emptyList()))
    }

    @Test
    fun blankQueryIsNotFound() {
        assertEquals(ContactsResolver.ContactLookup.NotFound, ContactsResolver.decide("   ", listOf(c("Dad", "5550199"))))
    }
}
