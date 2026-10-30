// The masking policy, with realistic log lines and documents.
//   Mask:       customer personal data only (emails, names and usernames in name fields, formatted phones and phone
//               fields, grouped cards and card fields, addresses, birth dates, government and bank ids, health data,
//               geo points, credentials, PUBLIC IP addresses).
//   Never mask: identifiers (account, order, subscription and billing ids, UUIDs, ObjectIds, trace ids, hex strings,
//               SKUs, device identifiers, bare digit runs of any length) and internal IP addresses.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fieldKind } from "../src/mask/kinds.ts";
import { maskText, maskValue, masker, render } from "./mask-support.ts";

/** Lines made only of identifiers and infrastructure: masking must return them byte for byte. */
const IDENTIFIER_LINES = [
    "2026-10-13T10:11:12.345Z INFO [provisioning] customerAccountId=1234567890 parentOrderId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee started",
    "2026-10-13T10:11:12.345Z INFO [billing] order 4532015112830366 posted for crmAccountId=0013000000AbCdE accountNumber=A00012345",
    "2026-10-13T10:11:12.345Z INFO [billing-sync] externalId=2c92c0f96b1b7b2c016b2a4d9e8f0001 subscriptionId=A-S00012345 invoiceId=INV00004567",
    "2026-10-13T10:11:12.345Z DEBUG [trace] traceId=4bf92f3577b34da6a3ce929d0e0e4736 spanId=00f067aa0ba902b7 parentSpanId=53995c3f42cd8ad8",
    "2026-10-13T10:11:12.345Z INFO [mongo] findOne _id=507f1f77bcf86cd799439011 originId=abcdef0123456789abcdef01 provisionAppId=app-77",
    "2026-10-13T10:11:12.345Z INFO [devices] deviceId=SN-20260101-77 mac=02:42:ac:11:00:02 imei=490154203237518 iccid=8944500102198304826 imsi=310150123456789",
    "2026-10-13T10:11:12.345Z INFO [devices] registered device 02:42:ac:11:00:02 with IMEI 490154203237518 and ICCID 8944500102198304826",
    "2026-10-13T10:11:12.345Z INFO [catalog] sku=SIP-TRUNK-100 plan=PLAN-2026-ENT status=ACTIVE version=3.14.2.1 build=20261013",
    "2026-10-13T10:11:12.345Z INFO [net] connected from 10.12.0.7 to 192.168.4.20 via 172.20.1.1 (127.0.0.1, 169.254.169.254, 100.64.0.9, fe80::1, fc00::2, ::1)",
    "2026-10-13T10:11:12.345Z WARN [cdr] reference 14155550132 and 4155550132 not found; batch 20261013123456 ticket PROJ-1234",
    "2026-10-13T10:11:12.345Z INFO [orders] ids 1234567890123 9876543210987654 00123456789 4532015112830366 4111111111111111 in batch",
    "GET /api/v2/accounts/0013000000AbCdE/orders?accountId=0013000000AbCdE&orderId=ord-7701&traceId=4bf92f3577b34da6a3ce929d0e0e4736 200 12ms",
    "uuid 123e4567-e89b-12d3-a456-426614174000 oid 507f1f77bcf86cd799439011 hex deadbeefcafebabe0123456789abcdef",
];

describe("identifiers are never masked", () => {
    for (const line of IDENTIFIER_LINES) {
        it(line.slice(24, 110), () => assert.equal(maskText(line), line));
    }

    it("keeps every identifier field of a document", () => {
        const document = {
            _id: { $oid: "507f1f77bcf86cd799439011" },
            customerAccountId: "1234567890",
            crmAccountId: "0013000000AbCdE",
            accountNumber: "A00012345",
            accountId: "acct-demo-1",
            externalId: "2c92c0f96b1b7b2c016b2a4d9e8f0001",
            externalAccountId: "2c92c0f96b1b7b2c016b2a4d9e8f0002",
            subscriptionId: "A-S00012345",
            subscriptionNumber: "A-S00012345",
            orderCorrelationId: "123e4567-e89b-12d3-a456-426614174000",
            provisionId: "abcdef0123456789abcdef02",
            parentOrderId: 4532015112830366,
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            sku: "SIP-TRUNK-100",
            device: {
                deviceId: "SN-1",
                macAddress: "02:42:ac:11:00:02",
                imei: "490154203237518",
                iccid: "8944500102198304826",
                imsi: "310150123456789",
            },
            serial: 4155550132,
            reference: "14155550132",
            internalHosts: ["10.12.0.7", "192.168.4.20", "172.16.0.1"],
            clientIp: "10.12.0.7",
            remoteAddress: "192.168.4.20",
            note: "ticket 4155550132 for order 4532015112830366 on 02:42:ac:11:00:02",
        };
        assert.deepEqual(maskValue(structuredClone(document)), document);
    });

    it("leaves device identifiers as they are, in fields and in text", () => {
        const input = { mac: "02:42:ac:11:00:02", imei: "490154203237518", note: "02:42:ac:11:00:02" };
        assert.deepEqual(maskValue(input), input);
    });
});

describe("customer personal data is masked", () => {
    it("masks personal data in log lines and keeps the identifiers around it", () => {
        const cases: Array<{ line: string; gone: string[]; kept: string[]; tags: string[] }> = [
            {
                line: "2026-10-13T10:11:12.345Z INFO [crm] customerAccountId=1234567890 contact alex.example@example.com updated crmAccountId=0013000000AbCdE",
                gone: ["alex.example@example.com"],
                kept: ["customerAccountId=1234567890", "crmAccountId=0013000000AbCdE"],
                tags: ["email#"],
            },
            {
                line: "2026-10-13T10:11:12.345Z WARN [callback] call-back (415) 555-0132 or 415-555-0132 or 415.555.0132 for order 4532015112830366",
                gone: ["555-0132", "555.0132"],
                kept: ["order 4532015112830366"],
                tags: ["phone#"],
            },
            {
                line: "2026-10-13T10:11:12.345Z INFO [cdr] did=4155550132 callingNumber=+14155550133 calledNumber=4155550134 callId=call-9",
                gone: ["4155550132", "4155550133", "4155550134"],
                kept: ["callId=call-9"],
                tags: ["phone#"],
            },
            {
                line: '2026-10-13T10:11:12.345Z INFO [billing] contactName="Avery Sample" asked about order 4532015112830366',
                gone: ["Avery Sample"],
                kept: ["order 4532015112830366"],
                tags: ["name#"],
            },
            {
                line: "2026-10-13T10:11:12.345Z INFO [auth] login username=casey.sample from 203.0.113.9 (gateway 10.12.0.7)",
                gone: ["casey.sample", "203.0.113.9"],
                kept: ["10.12.0.7"],
                tags: ["user#", "ip#"],
            },
            {
                line: "2026-10-13T10:11:12.345Z ERROR [payments] card 4111 1111 1111 1111 declined, also 4111-1111-1111-1111, order 4532015112830366",
                gone: ["4111 1111", "4111-1111"],
                kept: ["order 4532015112830366"],
                tags: ["card ****1111"],
            },
            {
                line: "2026-10-13T10:11:12.345Z INFO [service] install at 123 Example Lane, Sample City, CA 94000, US for customerAccountId=1234567890",
                gone: ["123 Example Lane", "Sample City", "94000", "CA"],
                kept: ["[removed:address]", "customerAccountId=1234567890"],
                tags: [],
            },
            {
                line: "2026-10-13T10:11:12.345Z INFO [kyc] applicant DOB 02/03/1982 SSN 900-12-3456 gps=40.712776,-74.005974",
                gone: ["02/03/1982", "900-12-3456", "40.712776"],
                kept: [],
                tags: ["[removed:birth]", "[removed:government]", "[removed:geo]"],
            },
            {
                line: "2026-10-13T10:11:12.345Z WARN [auth] retry password=hunter2 api_key=abc123 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 tok_FAKE_TEST_ONLY_001abcdef",
                gone: ["hunter2", "abc123", "abcdefghijklmnopqrstuvwxyz0123", "tok_FAKE"],
                kept: [],
                tags: ["[removed:credential]"],
            },
        ];
        for (const { line, gone, kept, tags } of cases) {
            const out = maskText(line);
            for (const needle of gone) assert.ok(!out.includes(needle), `leaked ${needle}: ${out}`);
            for (const needle of kept) assert.ok(out.includes(needle), `lost ${needle}: ${out}`);
            for (const tag of tags) assert.ok(out.includes(tag), `missing ${tag}: ${out}`);
        }
    });

    it("masks personal data in a customer document and keeps its ids", () => {
        const document = {
            customerAccountId: "1234567890",
            crmAccountId: "0013000000AbCdE",
            accountNumber: "A00012345",
            customer: {
                firstName: "Alex",
                lastName: "Example",
                fullName: "Alex Example",
                email: "alex.example@example.com",
                dob: "1980-01-02",
                ssn: "900-12-3456",
                did: "4155550132",
                contactPhone: "(415) 555-0132",
                serviceAddress: {
                    street: "123 Example Lane",
                    city: "Sample City",
                    state: "CA",
                    postalCode: "94000",
                    country: "US",
                },
                login: "alex.example",
                password: "hunter2",
                securityAnswer: "blue",
                cardNumber: "4532015112830366",
                cvv: "123",
                latitude: 40.712776,
                clientIp: "203.0.113.9",
                bank: { account: "000123456789", routing: "021000021" },
                iban: "GB82WEST12345698765432",
            },
        };
        const masked = maskValue(structuredClone(document));
        const out = render(masked);
        for (const leaked of [
            "Alex",
            "Example",
            "alex.example",
            "1980-01-02",
            "900-12-3456",
            "4155550132",
            "555-0132",
            "123 Example Lane",
            "Sample City",
            "94000",
            "hunter2",
            "blue",
            "4532015112830366",
            '"123"',
            "40.712776",
            "203.0.113.9",
            "000123456789",
            "021000021",
            "GB82WEST",
        ])
            assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`);
        assert.equal(masked.customerAccountId, "1234567890");
        assert.equal(masked.crmAccountId, "0013000000AbCdE");
        assert.equal(masked.accountNumber, "A00012345");
        assert.equal(masked.customer.serviceAddress, "[removed:address]");
        assert.equal(masked.customer.cardNumber, "card ****0366");
        assert.match(masked.customer.email, /^email#[0-9a-f]{6}$/);
        assert.match(masked.customer.did, /^phone#[0-9a-f]{6}-0132$/);
        assert.equal(
            masked.customer.did.slice(0, -5),
            masked.customer.contactPhone.slice(0, -5),
            "one number, one token",
        );
        assert.match(masked.customer.firstName, /^name#/);
        assert.match(masked.customer.login, /^user#/);
        assert.match(masked.customer.clientIp, /^ip#/);
    });
});

describe("addresses", () => {
    it("are removed whole, in any shape, and keep no state or country", () => {
        const out = maskValue({
            shippingAddress: "321 Sample Avenue, Demo Town, WA 00000, US",
            billingAddress: { street1: "123 Example Lane", city: "Sample City", state: "CA", country: "US" },
            addresses: [{ line1: "1 Main St" }, "2 Oak Rd"],
            postalCode: 94000,
            city: null,
        });
        assert.deepEqual(out, {
            shippingAddress: "[removed:address]",
            billingAddress: "[removed:address]",
            addresses: "[removed:address]",
            postalCode: "[removed:address]",
            city: "[removed:address]",
        });
    });

    it("are found in free text by their street, with whatever city, state and country follows", () => {
        for (const [input, expected] of [
            ["Install at 123 Example Lane", "Install at [removed:address]"],
            ["Install at 123 Example Lane before Friday", "Install at [removed:address] before Friday"],
            ["at 456 Demo Street, Sample City, CA 94000, US done", "at [removed:address] done"],
            ["at 12 Park Avenue and 9 Elm Blvd", "at [removed:address] and [removed:address]"],
        ] as const) {
            assert.equal(maskText(input), expected, input);
        }
    });

    it("are not guessed from a number alone", () => {
        for (const line of [
            "5 items in stock",
            "order 12 shipped on time",
            "build 20261013 passed",
            "retry 3 of 5",
            "sku 100 Street-Lamp",
        ]) {
            assert.equal(maskText(line), line, line);
        }
    });
});

describe("phone numbers", () => {
    it("masks phone-formatted numbers in free text", () => {
        for (const phone of [
            "+14155550132",
            "+1 415 555 0132",
            "+442079460958",
            "(415) 555-0132",
            "(415)555-0132",
            "415-555-0132",
            "415.555.0132",
            "415 555 0132",
            "1-415-555-0132",
            "+1 (415) 555-0132 ext. 99",
        ]) {
            const out = maskText(`call ${phone} now`);
            assert.ok(out.includes("phone#"), `${phone}: ${out}`);
            assert.ok(!/\d{3}[ .-]?\d{4}|555/.test(out.replace(/-\d{4} now$/, "")), `${phone}: ${out}`);
            assert.ok(out.endsWith(" now"), out);
        }
    });

    it("leaves a bare digit run in free text alone, whatever its length", () => {
        for (const digits of [
            "4155550132",
            "14155550132",
            "004915112345678",
            "442079460958",
            "20261013123456",
            "123456789012",
        ]) {
            const line = `ref ${digits} done`;
            assert.equal(maskText(line), line);
        }
    });

    it("masks any value in a phone-named field", () => {
        const out = maskValue({
            phone: "4155550132",
            msisdn: 14155550132,
            tn: "415 5550132",
            did: "14155550132",
            callingNumber: "4155550132",
            cdr: { from: "4155550132", to: "4155550133" },
        });
        for (const value of [out.phone, out.msisdn, out.tn, out.did, out.callingNumber, out.cdr.from, out.cdr.to])
            assert.match(String(value), /^phone#[0-9a-f]{6}-\d{4}$/);
    });

    it("leaves a bare digit run in a non-phone field alone", () => {
        const input = {
            accountId: "4155550132",
            orderId: "14155550132",
            reference: 4155550132,
            serial: "4155550132",
            note: "4155550132",
            from: "4155550132",
            to: "4155550132",
        };
        assert.deepEqual(maskValue(structuredClone(input)), input);
    });
});

describe("card numbers", () => {
    it("masks grouped, Luhn-valid numbers in free text", () => {
        for (const card of [
            "4111 1111 1111 1111",
            "4111-1111-1111-1111",
            "5555 5555 5555 4444",
            "3782 822463 10005",
            "4222 2222 2222 2",
        ]) {
            assert.match(maskText(`paid with ${card} today`), /^paid with card \*{4}\d{1,4} today$/, card);
        }
    });

    it("leaves bare digit runs and Luhn-invalid groups alone", () => {
        for (const value of [
            "4532015112830366",
            "4111111111111111",
            "378282246310005",
            "4111 1111 1111 1112",
            "2026 1013 1234 5678",
            "1234-5678-9012-3456",
        ]) {
            const line = `order ${value} posted`;
            assert.equal(maskText(line), line);
        }
    });

    it("masks any value in a card-named field and always removes card secrets", () => {
        const out = maskValue({
            pan: "4532015112830366",
            card: "4111111111111111",
            cardNumber: 4111111111111111,
            cvv: "123",
            cvc: 456,
            expiry: "12/30",
        });
        assert.equal(out.pan, "card ****0366");
        assert.equal(out.card, "card ****1111");
        assert.equal(out.cardNumber, "card ****1111");
        for (const secret of [out.cvv, out.cvc, out.expiry]) assert.equal(secret, "[removed:card]");
    });
});

describe("IP addresses", () => {
    const internal = [
        "10.0.0.1",
        "10.255.255.254",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.0.1",
        "192.168.255.254",
        "127.0.0.1",
        "127.1.2.3",
        "169.254.169.254",
        "100.64.0.1",
        "100.127.255.254",
        "::1",
        "fc00::1",
        "fd12:3456:789a::1",
        "fe80::1",
        "febf::1",
        "::ffff:10.0.0.1",
    ];
    const publicAddresses = [
        "8.8.8.8",
        "203.0.113.9",
        "172.15.255.255",
        "172.32.0.1",
        "192.167.1.1",
        "192.169.0.1",
        "169.253.1.1",
        "169.255.1.1",
        "100.63.255.255",
        "100.128.0.1",
        "11.0.0.1",
        "9.255.255.255",
        "2001:db8::1",
        "2606:4700::1111",
        "fec0::1",
        "::ffff:8.8.8.8",
    ];

    it("keeps internal addresses readable in text and in IP fields", () => {
        for (const address of internal) {
            assert.equal(maskText(`peer ${address} up`), `peer ${address} up`, address);
            assert.deepEqual(maskValue({ clientIp: address }), { clientIp: address }, address);
        }
    });

    it("masks public addresses in text and in IP fields", () => {
        for (const address of publicAddresses) {
            assert.match(maskText(`peer ${address} up`), /^peer ip#[0-9a-f]{6} up$/, address);
            assert.match(String(maskValue({ clientIp: address }).clientIp), /^ip#[0-9a-f]{6}$/, address);
        }
    });

    it("masks only the public addresses of a list", () => {
        assert.equal(
            maskValue({ forwardedIp: "10.0.0.1, 203.0.113.9" }).forwardedIp.replace(/ip#[0-9a-f]{6}/, "ip#"),
            "10.0.0.1, ip#",
        );
    });

    it("gives one public address one token across spellings", () => {
        const m = masker();
        const token = m.value({ sourceIp: "2001:DB8:0:0:0:0:0:A" }).sourceIp;
        assert.equal(m.text("seen 2001:db8::a today"), `seen ${token} today`);
    });
});

describe("field names are judged by words", () => {
    it("never mistakes an identifier for a device (crmAccountId contains mac)", () => {
        for (const key of ["crmAccountId", "machineId", "macroId", "imeiNumber", "deviceId", "macAddress", "mac"]) {
            assert.equal(fieldKind(key, ""), "identifier", key);
        }
        assert.deepEqual(maskValue({ crmAccountId: "0013000000AbCdE", machineId: "m-1" }), {
            crmAccountId: "0013000000AbCdE",
            machineId: "m-1",
        });
    });

    it("does not read words out of longer words", () => {
        for (const key of [
            "domain",
            "ipoNumber",
            "remainingCount",
            "skipCount",
            "tripleTime",
            "scriptName",
            "secretary",
            "pinned",
            "shipping",
            "mapping",
            "firmware",
            "hostName",
            "serviceName",
            "bankName",
            "fileName",
            "geography",
            "address_type",
            "userNameFormat",
            "phoneType",
            "emailVerified",
            "passwordLength",
            "tokenType",
            "cardType",
            "loginCount",
        ]) {
            assert.equal(fieldKind(key, ""), "other", key);
        }
    });

    it("keeps account and location names (business names) and masks customer and contact names", () => {
        for (const key of ["accountName", "account_name", "locationName", "LOCATION_NAME"])
            assert.equal(fieldKind(key, ""), "other", key);
        for (const key of ["customerName", "contactName", "firstName"]) assert.equal(fieldKind(key, ""), "name", key);
        const masked = maskValue({
            accountName: "Example Cabinets Ltd",
            locations: [{ name: "Example Showroom" }],
            account: { name: "Example Cabinets Ltd", customerName: "Alex Smith", billToContact: { firstName: "Alex" } },
        });
        assert.equal(masked.accountName, "Example Cabinets Ltd");
        assert.equal(masked.locations[0].name, "Example Showroom");
        assert.equal(masked.account.name, "Example Cabinets Ltd");
        assert.match(masked.account.customerName, /^name#/);
        assert.match(masked.account.billToContact.firstName, /^name#/);
    });

    it("lets a word for a thing hide a person's name only where it can do no harm", () => {
        // `charges[].name` names a charge. But the same word inside a longer field name must not hide the person.
        for (const key of ["rateContactName", "amendmentOwnerName", "triggerUserFullName"])
            assert.equal(fieldKind(key, ""), "name", key);
        assert.equal(fieldKind("name", "charges"), "other");
        assert.equal(fieldKind("name", "rate"), "other");
        assert.equal(fieldKind("name", "contacts"), "name");
        assert.match(maskValue({ rateContactName: "Alex Example" }).rateContactName, /^name#/);
    });

    it("still finds the personal-data words, however the name is spelled", () => {
        const expected: Array<[string, string]> = [
            ["phoneNumber", "phone"],
            ["contact_phone", "phone"],
            ["MSISDN", "phone"],
            ["calling-number", "phone"],
            ["telephone", "phone"],
            ["emailAddress", "email"],
            ["EMAIL_ADDRESS", "email"],
            ["e-mail", "email"],
            ["contactEmail", "email"],
            ["primaryMail", "email"],
            ["username", "user"],
            ["userName", "user"],
            ["authUsername", "user"],
            ["portalLogin", "user"],
            ["loginId", "user"],
            ["firstname", "name"],
            ["Last Name", "name"],
            ["fullName", "name"],
            ["cardholderName", "name"],
            ["displayName", "name"],
            ["ipAddress", "ip"],
            ["clientIP", "ip"],
            ["sourceIPv6", "ip"],
            ["remoteAddress", "ip"],
            ["ipaddress", "ip"],
            ["cardNumber", "card"],
            ["creditCard", "card"],
            ["pan", "card"],
            ["cvv", "cardSecret"],
            ["cardExpiry", "cardSecret"],
            ["billingAddress", "address"],
            ["Street Address", "address"],
            ["postalCode", "address"],
            ["line1", "address"],
            ["zip", "address"],
            ["dateOfBirth", "birth"],
            ["dob", "birth"],
            ["birthDate", "birth"],
            ["ssn", "government"],
            ["taxId", "government"],
            ["driverLicense", "government"],
            ["passportNumber", "government"],
            ["iban", "bank"],
            ["routingNumber", "bank"],
            ["bankAccountNumber", "bank"],
            ["latitude", "geo"],
            ["gps", "geo"],
            ["serviceGeo", "geo"],
            ["password", "credential"],
            ["clientSecret", "credential"],
            ["access_token", "credential"],
            ["apiKey", "credential"],
            ["authorization", "credential"],
            ["accountPIN", "credential"],
            ["securityAnswer", "credential"],
            ["healthNote", "sensitive"],
            ["biometricTemplate", "sensitive"],
        ];
        for (const [key, kind] of expected) assert.equal(fieldKind(key, ""), kind, key);
        assert.equal(fieldKind("from", "cdr"), "phone");
        assert.equal(fieldKind("to", "usage"), "phone");
        assert.equal(fieldKind("from", ""), "other");
        assert.equal(fieldKind("account", "bank"), "bank");
        assert.equal(fieldKind("account", ""), "other");
    });

    it("treats accountNumber as a billing account number, not a bank account", () => {
        assert.equal(fieldKind("accountNumber", ""), "safe");
        const billing = { accountNumber: "A00012345", billing: { accountNumber: 123456789 } };
        assert.deepEqual(maskValue(billing), billing);
        assert.equal(maskValue({ bankAccountNumber: "000123456789" }).bankAccountNumber, "[removed:bank]");
        assert.equal(maskValue({ bank: { accountNumber: "000123456789" } }).bank.accountNumber, "[removed:bank]");
    });

    it("keeps descriptions of a field out of the personal-data rules", () => {
        const input = {
            phoneType: "MOBILE",
            emailVerified: true,
            passwordLength: 12,
            userNameFormat: "first.last",
            tokenType: "Bearer",
            addressType: "BILLING",
            loginCount: 7,
        };
        assert.deepEqual(maskValue(structuredClone(input)), input);
    });
});
