<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog;

/**
 * Every error code of the specification's Appendix A. The string value is the code exactly as the
 * specification writes it, and is what the conformance vectors compare.
 */
enum ErrorCode: string
{
    case InvalidJson = 'invalid-json';
    case HashMismatch = 'hash-mismatch';
    case VersionConflict = 'version-conflict';
    case UnsupportedSchemaVersion = 'unsupported-schema-version';
    case InvalidStructure = 'invalid-structure';
    case InvalidAmount = 'invalid-amount';
    case InvalidPer = 'invalid-per';
    case UnknownCurrency = 'unknown-currency';
    case UnknownUnit = 'unknown-unit';
    case UnitMismatch = 'unit-mismatch';
    case UnknownComponent = 'unknown-component';
    case UnknownTier = 'unknown-tier';
    case TierProviderMismatch = 'tier-provider-mismatch';
    case InvalidInstant = 'invalid-instant';
    case InvalidWindow = 'invalid-window';
    case WindowsOverlap = 'windows-overlap';
    case ConditionInputsInvalid = 'condition-inputs-invalid';
    case ConditionsMixed = 'conditions-mixed';
    case ConditionsNotExclusive = 'conditions-not-exclusive';
    case ConditionsNotCovering = 'conditions-not-covering';
    case SchedulesMismatch = 'schedules-mismatch';
    case DuplicateProvider = 'duplicate-provider';
    case DuplicateModel = 'duplicate-model';
    case DuplicateAlias = 'duplicate-alias';
    case DuplicateOffering = 'duplicate-offering';
    case AliasCollision = 'alias-collision';
    case MixedCurrencies = 'mixed-currencies';
    case OfferingWithoutPrice = 'offering-without-price';
    case InvalidVersion = 'invalid-version';
    case InvalidEffort = 'invalid-effort';
    case InvalidRequest = 'invalid-request';
    case UnknownProvider = 'unknown-provider';
    case UnknownModel = 'unknown-model';
    case UnknownOffering = 'unknown-offering';
    case InvalidUsage = 'invalid-usage';
    case QuantityOutOfRange = 'quantity-out-of-range';
    case UsageIncomplete = 'usage-incomplete';
    case ComponentNotOffered = 'component-not-offered';
    case UnsupportedComponent = 'unsupported-component';
    case InapplicableComponentUsed = 'inapplicable-component-used';
    case NoRateInForce = 'no-rate-in-force';
    case UnsupportedUnit = 'unsupported-unit';
    case BasisHashMismatch = 'basis-hash-mismatch';
    case UnsupportedBasisVersion = 'unsupported-basis-version';
    case InvalidBasis = 'invalid-basis';
    case DimensionMismatch = 'dimension-mismatch';
    case InexactConversion = 'inexact-conversion';
}
