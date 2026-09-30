// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 withdraw1 zkey sha256=cf41562efc29e7c2ceaa62912819893f3f360e66f9b4adf7a9bb0871456bd40b
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendWithdrawVerifier1 {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 14408427498395781616684265250352309429337219691521369329366965225068544594940;
    uint256 constant IC0y = 6292648847936860847877310530138982265599148269036986463695975589961118773766;

    uint256 constant IC1x = 9446400205036640862174132851470185577219915737723992528793220876990870549162;
    uint256 constant IC1y = 6850581212925861368128801622864876935484661191028322733835946713435694093707;

    uint256 constant IC2x = 21551365979198336587499756858121918810430129497074487488050664271749997810549;
    uint256 constant IC2y = 10755989159857337829980286237027823931931560141159507705144077665916632742677;

    uint256 constant IC3x = 16895819500472681273719938626622046815035695950420551235351423751512740247167;
    uint256 constant IC3y = 17562221160649666789570667849146615532058718094359022921311938616206283080462;

    uint256 constant IC4x = 16300020749893250224611457979419131894455087324738057262943843353778202919671;
    uint256 constant IC4y = 19102140379967770340478617325008347523632799213958574271857893635970652091625;

    uint256 constant IC5x = 7202607105272937548812889715485686543010536097168699808265873730495402610987;
    uint256 constant IC5y = 11544520985943811285523349781340969281411197380106630311778724720200879825972;

    uint256 constant IC6x = 9009306264885737168707930840248086355151610572255817871802882247325444464625;
    uint256 constant IC6y = 21709516740888210952064624680243267456157397696616134236496221850682269490249;

    uint256 constant IC7x = 19591827523712440793582867985967776077150701064155929163335939979597157050311;
    uint256 constant IC7y = 7561404754106783692635721067728636692457306688429144298863860345706785715399;

    uint256 constant IC8x = 18555327141336019857313092879934383707460608683937398292389113028986744914176;
    uint256 constant IC8y = 6094918610761152062653833812461659789119232261901090314354137032234526830446;

    uint256 constant IC9x = 731504996208795432716500972045051331479314658616788363494528866498723360824;
    uint256 constant IC9y = 596319415387941486683652503310754950919746346852114167061091252556331115873;

    uint256 constant IC10x = 13119767256632164409655540692895436247946279020964096143648774525964759405166;
    uint256 constant IC10y = 4466850640982946230183048296121529634302619297226263556314250935566563106304;

    uint256 constant IC11x = 6330294360090621894194728921294492373650818729051563373777040626010501580984;
    uint256 constant IC11y = 13832510257446968498551679198016228606031350472972577363037372394323414761774;

    uint256 constant IC12x = 6599327891772195372532918257594225849197568689680129114040775063163704311411;
    uint256 constant IC12y = 10023743667316077185832527585501904521920704079286126904750655013117691751942;

    uint256 constant IC13x = 3354677908062799316284615936121107006036703267839789960410651104594024030488;
    uint256 constant IC13y = 2111827735952364536367251813695746706148177217854156379746469721165551947760;

    uint256 constant IC14x = 3458680247299957207501706608465390207195698410977950013122078637688368230198;
    uint256 constant IC14y = 6953338908288197438234982270094745078809632225791182454209156497553439198935;

    uint256 constant IC15x = 17055097412340643939567429699881851270475525422012726088012819820117790232465;
    uint256 constant IC15y = 10161635599968681291984241849637575594116072764788507132132580446255454663365;

    uint256 constant IC16x = 10039255473357675433049395872099314604341112905624429188715425019155793339626;
    uint256 constant IC16y = 14327934734575665389496575334698258740564182828477447168166072277284101874873;

    uint256 constant IC17x = 18293148139478425572234979053616017623324137523682211161895233374623588328948;
    uint256 constant IC17y = 12714315870636926241956024490545829772233290838953984914285778620759327432908;

    uint256 constant IC18x = 8965882089217852910379923225781256631790188985883914914366910387943452802417;
    uint256 constant IC18y = 12072953491673934825338093017187526157640766070194963434093948331355481783381;

    uint256 constant IC19x = 8285043146040094247803948254734064440303744411916305532065311739417429096582;
    uint256 constant IC19y = 2799397625096079915296256294368158256248160310579580836791414566397169848705;

    uint256 constant IC20x = 1399679945082915497097144346460664903374957954996752510726118724485990740095;
    uint256 constant IC20y = 3074222629340235937748788438227847252478999394850874073802890130723568244367;

    uint256 constant IC21x = 9833560023677412724446497209015227153724222774089357690280145464813208138813;
    uint256 constant IC21y = 21336604351665972232176586652169025927429104641267784091098685058094037342024;

    uint256 constant IC22x = 3693410245191402738784029565630321676769798728349822379376318177648345764113;
    uint256 constant IC22y = 15792604098382643435265734949065154557393617261092192463111257509210431691434;

    uint256 constant IC23x = 11603655517378453598760492391725775506644339059180322752288318070280028009688;
    uint256 constant IC23y = 14337367515556846630154496146444893126407466675141819609333068521326532920121;

    uint256 constant IC24x = 1524502845794603050939591875610987414953532028343358950504637890338667494428;
    uint256 constant IC24y = 13518227233269096243121123272660057345815265079927831221222427062909599747522;

    uint256 constant IC25x = 3083059578242901964367098408016598278883250317385689394463466259806191617253;
    uint256 constant IC25y = 18287289616866294930645087747750395967821289506048582506127617440894726922960;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
