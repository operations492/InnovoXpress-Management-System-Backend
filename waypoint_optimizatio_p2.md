# Guidance Instructions | Routing API (Orbis v3)

## Purpose

This document describes route planning parameters that are related to guidance instructions. They can be used in the [Calculate Route](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route) service.

Please be aware that this document does not specify the complete request or response format. To maintain forward compatibility you must be able to process responses with additional non-documented data fields. Our deprecation policy only covers the documented subset of these formats.

### Prerequisite for support

Guidance instructions can only be requested when the `travelMode` parameter is `car`.

## Request data

### HTTPS methods: `POST`

The functionality described here extends the functionality of the endpoint described in [Calculate Route](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route).

**Note:** Only additional parameters and behaviours over the ones in [Calculate Route](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route) are explicitly listed.

post

post request command example

```
curl -X POST "https://api.tomtom.com/maps/orbis/routing/routes/calculate" -H "Content-type:application/json" -H "TomTom-Api-Version:3" -H "TomTom-Api-Key:{Your_API_Key}" -H "Attributes:routes" -d \'{  "routePlanningLocations": {    "origin": {      "type": "Point",      "coordinates": [13.42936, 52.50931]    },    "destination": {      "type": "Point",      "coordinates": [13.43872, 52.50274]    }  },  "guidance": "instructions",  "instructionPhonetics": "ipa"}'
```

### POST data parameters

The `guidance` parameter controls whether guidance instructions are going to be included in the response. In case guidance instructions are requested, `instructionPhonetics` control the type of the phonetic translations of the name fields returned in the response.

To enable Guidance Instructions, set the guidance parameter to `instructions`. Omitting the parameter (or setting its value to `none`) will disable Guidance Instructions.

Parameter

Description

`guidance` *string*

Possible values are `none` (the default, same as omitting it) and `instructions`. Setting it to `instructions` enables the generation of guidance instructions, which are returned in the `instructions` field of the response.

`instructionPhonetics` *string*

Possible values are `ipa` and `lhp`.

Setting it to `ipa` returns phonetic transcriptions in the IPA (International Phonetic Alphabet) format, while setting it to `lhp` returns phonetic transcriptions in the L&H+ format from Cerence Inc.

This parameter is mandatory if `guidance` is set to `instructions`, and can’t be used otherwise.

In scope of guidance instruction API this header controls:

*   The language in which proper names (e.g. street names) are returned in the coded instruction fields, along with their phonetic transcriptions. If the names are not available in the requested language, the engine will return them in the closest available language.
    
*   The language in which the human readable instruction text is generated. If the language is not available for instruction text generation and the human readable messages were requested, this will result in a user error.
    

See [Calculate Route](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route#request-headers) for the general description.

## Response data

### Example of a successful response

**Note**: The example below intentionally includes all fields defined in this specification. In actual responses, certain fields are mutually exclusive and the set of returned fields varies based on the maneuver type associated with each instruction.

Successful response body

```
{  [...]  "routes": [    {      "summary": [...]      "legs": [...],      "instructions": [        ...prior instructions...        {          "routeOffsetInMeters": 1141,          "maneuverPoint": {            "latitude": 52.37236,            "longitude": 4.90861          },          "routePath": [            {              "point" : {                "latitude": 52.37236,                "longitude": 4.90861              },              "distanceFromRouteStartInMeters" : 1150,              "travelTimeFromRouteStartInSeconds" : 45            },            {              "point" : {                "latitude": 52.37245,                "longitude": 4.90831              },              "distanceFromRouteStartInMeters" : 1160,              "travelTimeFromRouteStartInSeconds" : 46            },            {              "point" : {                "latitude": 52.37255,                "longitude": 4.90805              },              "distanceFromRouteStartInMeters" : 1170,              "travelTimeFromRouteStartInSeconds" : 47            }          ],          "maneuver": "turnRight",          "maneuverView": {            "onRouteAngle": "right",            "offRouteAngles": ["straight", "left"]          },          "previousRoadInformation": {            "properties": ["motorway"],            "streetName": {              "text": "Max-Brauer-Allee",              "phonetic": "maks \"braU|6 ?a|\"le:",              "phoneticLanguageCode": "de-DE"            },            "roadShields": [              {                "roadNumber": {                  "text": "b208",                  "phonetic": "be: %tsvaI|hUn|d6t|\"?axt",                  "phoneticLanguageCode": "de-DE",                },                "countryCodeIso2": "NL"              },              ...further road shields...            ],          },          "nextRoadInformation": {            "properties": ["motorway", "urban"],            "streetName": {              "text": "Schnellstraße",              "phonetic": "SnEl|%Stra:|s@",              "phoneticLanguageCode": "de-DE"            },            "roadShields": [              {                "roadNumber": {                  "text": "a2",                  "phonetic": "?a: \"tsvaI",                  "phoneticLanguageCode": "de-DE",                },                "countryCodeIso2": "NL"              },              {                "roadNumber": {                  "text": "a12",                  "phonetic": "?a: \"tsv9lf",                  "phoneticLanguageCode": "de-DE",                },                "countryCodeIso2": "NL"              },               ...further road shields...            ]          },          "signpost": {            "exitName": {              "text": "Grünewald",              "phonetic": "gru:|n@|%valt",              "phoneticLanguageCode": "de-DE"            },            "exitNumber": {              "text": "3",              "phonetic": "dRaI",              "phoneticLanguageCode": "de-DE"            },            "towardName": {              "text": "Potsdam",              "phonetic": "pOts|dam",              "phoneticLanguageCode": "de-DE"            },          },          "intersectionName": {            "text": "Oranienenburger Tor",            "phonetic": "?o:|\"ra:|nj@n|%bUr|g6 \"to:6^",            "phoneticLanguageCode": "de-DE"          },          "isManeuverObligatory": false,          "changeOfAngleInDegrees": 45,          "roundaboutExitNumber": 2,          "roundaboutType": "regular",          "tollgateName": {            "text": "Koblenz",            "phonetic": "ko:|blEnts",            "phoneticLanguageCode": "de-DE"          },          "tollPaymentTypes": [            "creditCard",            "debitCard",            "etc",            "etcTransponder",            "etcVideoCamera",            "subscription"          ],          "countryCrossingFromName": {            "text": "Frankreich",            "phonetic": "fraNk|raIC",            "phoneticLanguageCode": "de-DE"          },          "countryCrossingFromCodeIso2": "FR",          "countryCrossingToName": {            "text": "Deutschland",            "phonetic": "dOYtS|lant",            "phoneticLanguageCode": "de-DE"          },          "countryCrossingToCodeIso2": "DE",          "drivingSide": "right",          "landmark": "atTrafficLight",          "distanceToPreviousTrafficLightInMeters": 18,          "ambiguousExitOffsetFromManeuverInMeters": 27,          "instructionMessage" : "Turn right onto Schnellstraße.",          "sideRoads": [            {              "side": "left",              "offsetFromManeuverInMeters": 66,              "isDrivable": true            },            {              "side": "right",              "offsetFromManeuverInMeters": 42,              "isDrivable": false            },            ...further side roads...          ]        },        ...further instructions...        ],    }  ...further routes...  ],  ...}
```

### Structure of the `Instruction` object

#### Common fields for all maneuvers

JSON field

Description

`maneuver` *string*

A code identifying the maneuver. Possible values:

*   `depart` *Leave.*
*   `waypointReached` *You have reached the waypoint.*
*   `waypointLeft` *You have reached the waypoint. It is on the left.*
*   `waypointRight` *You have reached the waypoint. It is on the right.*
*   `waypointAhead` *You have reached the waypoint. It is ahead on the road.*
*   `arrive` *You have arrived.*
*   `arriveLeft` *You have arrived. The destination is on the left.*
*   `arriveRight` *You have arrived. The destination is on the right.*
*   `arriveAhead` *You have arrived. The destination is ahead.*
*   `keepLeft` *Keep left at the fork.*
*   `keepRight` *Keep right at the fork.*
*   `keepCenter` *Keep middle at the fork.*
*   `continueStraight` *Continue ahead.*
*   `turnSlightRight` *Make a slight right.*
*   `turnRight` *Turn right.*
*   `turnSharpRight` *Make a sharp right.*
*   `turnSlightLeft` *Make a slight left.*
*   `turnLeft` *Turn left.*
*   `turnSharpLeft` *Make a sharp left.*
*   `makeUTurn` *Make a U-turn.*
*   `roundaboutStraight` *Continue straight across the roundabout.*
*   `roundaboutSharpRight` *At the roundabout take the exit in the sharp right direction.*
*   `roundaboutRight` *At the roundabout take the exit in the right direction.*
*   `roundaboutSlightRight` *At the roundabout take the exit in the slight right direction.*
*   `roundaboutSharpLeft` *At the roundabout take the exit in the sharp left direction.*
*   `roundaboutLeft` *At the roundabout take the exit in the left direction.*
*   `roundaboutSlightLeft` *At the roundabout take the exit in the slight left direction.*
*   `roundaboutBack` *Go around the roundabout.*
*   `exitRoundabout` *Exit the roundabout.*
*   `exitMotorwayRight` *Exit the motorway on the right.*
*   `exitMotorwayLeft` *Exit the motorway on the left.*
*   `exitMotorwayMiddle` *Take the middle exit on the motorway.*
*   `switchMotorwayRight` *Take the right exit to switch the motorway.*
*   `switchMotorwayLeft` *Take the left exit to switch the motorway.*
*   `switchMotorwayMiddle` *Take the middle exit to switch the motorway.*
*   `enterCarpoolLaneRight` *Enter the carpool lane on the right.*
*   `enterCarpoolLaneLeft` *Enter the carpool lane on the left.*
*   `exitCarpoolLaneRight` *Keep right to exit the carpool lane.*
*   `exitCarpoolLaneLeft` *Keep left to exit the carpool lane.*
*   `mergeLeftLane` *Merge into the leftmost lane.*
*   `mergeRightLane` *Merge into the rightmost lane.*
*   `takeShipFerry` *Take the ship ferry.*
*   `leaveShipFerry` *Disembark from the ship ferry.*
*   `takeCarTrain` *Take the car train.*
*   `leaveCarTrain` *Disembark from the car train.*
*   `crossBorder` *Cross the border.*
*   `passTollgate` *Pass through the tollgate.*

`maneuverPoint` *`GeoJsonPoint` object*

A representative point of the maneuver. **Note:** Can be used to depict a maneuver as a single point on the map, but no further assumptions how it relates to other attributes must be made.

`routeOffsetInMeters` *number*

The distance on route from the start of the route to the `maneuverPoint`.

`routePath` *array of `RoutePathPoint` objects*

A maneuver’s geometry is defined as a polyline, which may consist of multiple coordinate points. For such maneuvers, this field returns the ordered list of points that constitute the maneuver’s geometry. For maneuvers that only occupy a single point, this field will contain a single array item, with a `point` value equal to `maneuverPoint`.

`previousRoadInformation` *`RoadInformation` object*

Provides information about the road in the link before the maneuver.

`nextRoadInformation` *`RoadInformation` object*

Provides information about the road that the route continues onto immediately after the maneuver. If a signpost related to the maneuver is available this information is taken from it. Otherwise it is obtained from the road segment beyond the maneuver.

`signpost` *`Signpost` object*

Present only when a signpost associated with this maneuver is available. Provides the signpost information that corresponds to the maneuver and indicates the subsequent direction along the route.

`intersectionName` *`TextWithPhonetics` object*

Name of the intersection at which the maneuver must be performed. Included if intersection name is available for this maneuver.

`drivingSide` *string*

Indicates whether driving at the maneuver location follows left‑hand or right‑hand traffic rules. Possible values:

*   `left`
*   `right`

`landmark` *string*

A notable feature near the maneuver that can help orient the driver. Included if a landmark is available for this maneuver. Possible values:

*   `endOfRoad`: the maneuver is at the end of a road.
*   `atTrafficLight`: the maneuver is at a traffic light.
*   `onToBridge`: the maneuver leads onto a bridge.
*   `onBridge`: the maneuver takes place on a bridge.
*   `afterBridge`: the maneuver takes place after a bridge.
*   `intoTunnel`: the maneuver leads into a tunnel.
*   `insideTunnel`: the maneuver takes place inside a tunnel.
*   `afterTunnel`: the maneuver takes place after a tunnel.

`sideRoads` *array of `SideRoad`*

List of roads that connect to the route immediately before the maneuver but are not part of the route itself. These are roads that a driver could mistakenly take, because they may appear drivable based on the instruction alone, even though they are excluded from the route due to dynamic restrictions such as time-dependent or vehicle-profile-dependent rules. Dual-carriageway roads may be represented as a single side road or as several, depending on how the driver would perceive them. The list is empty if no roads connect to the route before the maneuver. It is ordered by ascending offset along the route. This information can be used for a richer graphical representation of the maneuver, visualizing connected roads in proximity before it. Included if there are side roads within a reasonable distance before the maneuver.

`maneuverView` *`ManeuverView` object*

Schematic representation of the intersection for the maneuver. Intersection is considered as a point with connected roads.

Included if the maneuver is bound to an intersection.

`message` *string*

A human‑readable instruction message intended for display or text‑to‑speech output. The message is generated based on the maneuver and its attributes, and is localized to the language specified in the request.

#### Additional fields for turn maneuvers

`isManeuverObligatory` *boolean*

Marks this maneuver as obligatory. For example, when a driver reaches a T-junction, where one option is drivable, while the other is not. Included if the maneuver is a turn maneuver, i.e., `maneuver` is one of the following:

*   `turnSlightRight`
*   `turnRight`
*   `turnSharpRight`
*   `turnSlightLeft`
*   `turnLeft`
*   `turnSharpLeft`
*   `makeUTurn`

Note that the `continueStraight` maneuver is not included in the list, since there is no meaning for such maneuver to be obligatory.

#### Additional fields for turn and roundabout maneuvers

`changeOfAngleInDegrees` *number*

Represents the total change of angle (in degrees) from the entry until the exit of the maneuver, within the range `[-180,180)`. For example, `-90` means “forks off to the left in a perpendicular angle”. At complex junctions, the angle is relative to the entry road. Included if the maneuver is a turn or roundabout maneuver, i.e., `maneuver` is one of the following:

*   `continueStraight`
*   `turnSlightRight`
*   `turnRight`
*   `turnSharpRight`
*   `turnSlightLeft`
*   `turnLeft`
*   `turnSharpLeft`
*   `makeUTurn`
*   `roundaboutStraight`
*   `roundaboutSlightRight`
*   `roundaboutRight`
*   `roundaboutSharpRight`
*   `roundaboutSlightLeft`
*   `roundaboutLeft`
*   `roundaboutSharpLeft`
*   `roundaboutBack`

#### Additional fields for switch motorway maneuvers

`mergePointRouteOffsetInMeters` *number*

The route offset (in meters) indicating where the route merges onto the new motorway. Applicable for maneuvers where `maneuver` is one of the following values:

*   `switchMotorwayLeft`
*   `switchMotorwayRight`
*   `switchMotorwayMiddle`

#### Additional fields for exit motorway, switch motorway, and exit roundabout maneuvers

`ambiguousExitOffsetFromManeuverInMeters` *number*

Included if current maneuver is an exit, and there is another exit before the current maneuver within reasonable distance, which may cause ambiguity. In such case there might be a need to resolve the ambiguity on client side, and compose an instruction like “Take the 2nd exit”. Represents the offset (on route) of the ambiguous exit from the maneuver point (represented by `maneuverPoint`), in meters. The offset is absolute, i.e., it is a positive integer despite the ambiguous exit being located before the maneuver on the route. Applicable for maneuvers where `maneuver` is one of the following values:

*   `exitRoundabout`
*   `exitMotorwayLeft`
*   `exitMotorwayMiddle`
*   `exitMotorwayRight`
*   `switchMotorwayLeft`
*   `switchMotorwayMiddle`
*   `switchMotorwayRight`

#### Additional fields for roundabout maneuvers

`roundaboutExitNumber` *number*

The ordinal number of the exit to take at a roundabout, e.g., “take the first/second exit”. Included if the maneuver is a roundabout maneuver, i.e. `maneuver` is one of the following:

*   `roundaboutStraight`
*   `roundaboutSlightRight`
*   `roundaboutRight`
*   `roundaboutSharpRight`
*   `roundaboutSlightLeft`
*   `roundaboutLeft`
*   `roundaboutSharpLeft`
*   `roundaboutBack`

`roundaboutType` *string*

Indicates the roundabout type. Possible values:

*   `regular`
*   `small`

Included if the maneuver is a roundabout maneuver, i.e. `maneuver` is one of the following:

*   `roundaboutStraight`
*   `roundaboutSlightRight`
*   `roundaboutRight`
*   `roundaboutSharpRight`
*   `roundaboutSlightLeft`
*   `roundaboutLeft`
*   `roundaboutSharpLeft`
*   `roundaboutBack`

#### Additional fields for tollgate maneuvers

`tollgateName` *`TextWithPhonetics` object*

The name of the tollgate, if available. Included if the maneuver is a tollgate maneuver, i.e., `maneuver` is `passTollgate`.

`tollPaymentTypes` *array of strings*

Array containing one or more available toll payment options for this tollgate. Possible values are:

*   `cashCoinsAndBills`
*   `cashBillsOnly`
*   `cashCoinsOnly`
*   `cashExactChange`
*   `creditCard`
*   `debitCard`
*   `travelCard`
*   `etc`
*   `etcTransponder`
*   `etcVideoCamera`
*   `subscription`

#### Additional fields for maneuvers leading to a border crossing

`countryCrossingFromName` *`TextWithPhonetics` object*

The name of the country the border crossing occurs from. Included if the maneuver is a border crossing maneuver, or leads to a border crossing, i.e. `maneuver` is one of:

*   `crossBorder`
*   `takeShipFerry`
*   `takeCarTrain`
*   `leaveShipFerry`
*   `leaveCarTrain`

`countryCrossingFromCodeIso2` *`CountryCodeIso2` object*

Country code (ISO 3166-1 alpha-2) of the country the border crossing occurs from. Included if the `maneuver` is one of:

*   `crossBorder`
*   `takeShipFerry`
*   `takeCarTrain`
*   `leaveShipFerry`
*   `leaveCarTrain`

`countryCrossingToName` *`TextWithPhonetics` object*

The name of the country the border crossing occurs to. Included if the maneuver is a border crossing maneuver, i.e. `maneuver` is one of:

*   `crossBorder`
*   `takeShipFerry`
*   `takeCarTrain`
*   `leaveShipFerry`
*   `leaveCarTrain`

`countryCrossingToCodeIso2` *`CountryCodeIso2` object*

Country code (ISO 3166-1 alpha-2) of the country the border crossing occurs to. Included if the `maneuver` is one of:

*   `crossBorder`
*   `takeShipFerry`
*   `takeCarTrain`
*   `leaveShipFerry`
*   `leaveCarTrain`

#### Structure of the `RoutePathPoint` object

JSON field

Description

`point` *`GeoJsonPoint` object*

The latitude and longitude of the point on the map. See [Calculate Route](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route).

`distanceFromRouteStartInMeters` *number*

Distance (in meters) from the start of the route to this point.

`travelTimeFromRouteStartInSeconds` *number*

Travel duration (in seconds) from the start of the route to this point.

#### Structure of the `RoadInformation` object

JSON field

Description

`properties` *array of strings*

The properties of road, as a possible combination of several values. Possible values:

*   `urban`: represents an urban road type.
*   `motorway`: represents a motorway road type.
*   `controlledAccess`: represents a controlled access road with regulated traffic flow and regulated entries and exits.

`roadShields` *array of `RoadShield` objects*

Lists the road shields for this road. The list can be empty if no road shields are available.

`roadNumbers` *array of `RoadIdentifier` objects*

Lists the road numbers with phonetic information, road attribute, and source.

`roadNames` *array of `RoadIdentifier` objects*

Lists the road names with phonetic information and source.

`countryCodeIso2` *`CountryCodeIso2` object*

Country code (ISO 3166-1 alpha-2) of the country.

#### Structure of the `Signpost` object

JSON field

Description

`exitName` *`TextWithPhonetics` object*

Exit name of the controlled access road. Included if an exit name is available for this signpost.

`exitNumber` *`TextWithPhonetics` object*

Exit number of the controlled access road. Included if an exit number is available for this signpost. If the exit number is not available, the field will be absent.

`towardName` *`TextWithPhonetics` object*

The toward name from the signpost.

#### Structure of the `TextWithPhonetics` object

JSON field

Description

`text` *string*

The name as a text string.

`phonetic` *string*

The phonetic transcription of the name. Included if phonetic transcription is available for the specific name, and phonetic transcriptions have been requested by the client. **Note:** The phonetic transcription can contain double quote characters (`"`). In this case those characters are escaped with a backslash (`\`).

`phoneticLanguageCode` *`LanguageTag` object*

BCP47 language code indicating the language of the phonetic transcription. For example, **“en-GB”** for English as used in the United Kingdom, **“de-DE”** for German as used in Germany, etc.

Included if phonetic transcription is available for the specific name, and phonetic transcriptions have been requested by the client.

#### Structure of the `SideRoad` object

JSON field

Description

`side` *string*

Side from where the road connects to the route. Possible values:

*   `left`
*   `right`

`offsetFromManeuverInMeters` *number*

Offset (on route) of the side road from the maneuver point (represented by `maneuverPoint`), in meters. The offset is absolute, i.e., it is a positive integer despite that the side road is located before the maneuver on the route.

`isDrivable` *boolean*

Whether the side road is drivable or not.

#### Structure of the `ManeuverView` object

JSON field

Description

`onRouteAngle` *string*

The quantized angle of the on-route outgoing road relative to the driving direction. Possible values:

*   `straight`
*   `slightRight`
*   `right`
*   `sharpRight`
*   `back`
*   `sharpLeft`
*   `left`
*   `slightLeft`

`offRouteAngles` *array of strings*

The quantized angles of the off-route outgoing roads relative to the driving direction. Possible values:

*   `straight`
*   `slightRight`
*   `right`
*   `sharpRight`
*   `back`
*   `sharpLeft`
*   `left`
*   `slightLeft`

#### Structure of the `RoadShield` object

JSON field

Description

`roadNumber` *`TextWithPhonetics` object*

The road number. Most road numbers have a ‘letter’ prefix, which is also returned. For example, a call for the German motorway returns “A40” rather than “40”.

`countrySubdivisionCodeIso` *string*

The state code of the state the shield is in, as an ISO 3166-2 identifier. Included if sub-country codes are available for the country the road shield is located in.

`countryCodeIso2` *string*

Country code (ISO 3166-1 alpha-2) of the country the shield is in.

#### Structure of the `RoadIdentifier` object

JSON field

Description

`identifier` *`TextWithPhonetics` object*

Text and phonetic transcription of the road number or name.

`source` *string*

Indicates the origin of the road identifier data. Possible values:

*   `signpost`: the identifier was derived from signpost information.
*   `road`: the identifier was derived from the road segment itself.

`roadAttribute` *string*

Special road attribute of the road identifier. Note that these are currently added only for KR, JP and TW. More values might be added in the future, for other regions/countries and road types. Possible values:

*   `nationalRoad` National Route (JP), National Road (KR)
*   `prefecturalRoad` Prefectural Road (JP)
*   `tokyoPrefecturalRoad` Prefectural Road in the Tokyo Prefecture (JP)
*   `hokkaidoPrefecturalRoad` Prefectural Road in the Hokkaido Prefecture (JP)
*   `osakaAndKyotoPrefecturalRoad` Prefectural Road in the Osaka and Kyoto Prefecture (JP)
*   `expressway` Expressways (JP), Expressways (KR)
*   `countyRoad` County Roads (TW)
*   `nationalHighway` National Highways (TW)
*   `provincialHighway` Provincial Highways (TW)
*   `provincialRoad` Provincial Road (KR)
*   `townshipRoad` Township Roads (TW), City Roads (KR)