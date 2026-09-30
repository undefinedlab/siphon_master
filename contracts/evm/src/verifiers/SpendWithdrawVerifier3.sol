// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 withdraw3 zkey sha256=a89de9cb7942aa10b4c80359d5f17f4588c4957891e97230b81ae2a5039743c8
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

contract SpendWithdrawVerifier3 {
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


    uint256 constant IC0x = 899389574864193970465357129185877410670862188140468896913474493047774949264;
    uint256 constant IC0y = 10963441592805483197188957833192103934301099551147366319281333014386505157042;

    uint256 constant IC1x = 9798036613856806754069523977289143788284131150893081518565001194971965673599;
    uint256 constant IC1y = 21867658149130935016593145199525106590939611419394463712751847143503473656143;

    uint256 constant IC2x = 3265639674663992285891586977717441458112508243199928154479047498666492201234;
    uint256 constant IC2y = 15773917368210129074561001805464722258166013881260352014544468801473479914341;

    uint256 constant IC3x = 2187580491767199984142745182460043759696083001144832824521328601947171350011;
    uint256 constant IC3y = 14525289155263064950689723604806327649282716019863154493287394282086010894809;

    uint256 constant IC4x = 4435653824524531921707468304823213340094557266977648422896101590325195097733;
    uint256 constant IC4y = 14362930601188589790797231156976834696098620571893319695178846681242991648970;

    uint256 constant IC5x = 4546698251439349147402248509025440283233921841871633037727236381192314003949;
    uint256 constant IC5y = 17068770853252838980205203377510099128762176279451534781877862545941777077059;

    uint256 constant IC6x = 10538507040146910445945262224472997387184517383090451882367614326290327599183;
    uint256 constant IC6y = 8814321150793173741157497281865025033117097034588383056618759341941862715253;

    uint256 constant IC7x = 14382234365584079379856506893418182537877007202884283188201289997975905158942;
    uint256 constant IC7y = 7794573228826737957835312310557983690425485857583746874479903705557196217472;

    uint256 constant IC8x = 4588111661969133769991877409859734396766579991629084976313611028385605320565;
    uint256 constant IC8y = 19371703256499558987184669299202213657085677979041983268278377313101137502677;

    uint256 constant IC9x = 10351310628957087447210611520905661485160367479376585483804107933109372330059;
    uint256 constant IC9y = 1336623705969605615640715206210940536285793744199379593082372557486416843873;

    uint256 constant IC10x = 14363948390852466378477765992796630220901058621548633116600792296971555698814;
    uint256 constant IC10y = 5322791719231379522243471549065526528941895980019226554779558472528828140678;

    uint256 constant IC11x = 16025323929647597750907651543081205282638696012501810029062986218629905927761;
    uint256 constant IC11y = 3071883382590070126257797492435473243175251558293092996656163900879804057862;

    uint256 constant IC12x = 10050683070075639541120141042069049405626527056655980922832040582092038302363;
    uint256 constant IC12y = 14198714523796968922094391505784585498611577330014403403000808710027667812185;

    uint256 constant IC13x = 16293563363602896519160193867464464742576267601745598169821211976314876625968;
    uint256 constant IC13y = 11245102803437461297820173824898139030259018295599851257780627484233681279402;

    uint256 constant IC14x = 20077827840537909787979654789350778279455400511213999547191309139785584629454;
    uint256 constant IC14y = 19338976961536811458791179550204853363255299964887364897204781608437847524566;

    uint256 constant IC15x = 8132304005622351560886145492118163742602557626144184489571477258657269167127;
    uint256 constant IC15y = 18798088682158060271658711415630665793044462523605974567903369546542951778350;

    uint256 constant IC16x = 14503347103777950030088574715566020347469124394888314356592156945628802800930;
    uint256 constant IC16y = 21285452258092143647275604436216113109039896687149073938709056741593067862400;

    uint256 constant IC17x = 1892718575666085027177944274345268231234258041243238576170823730066299257080;
    uint256 constant IC17y = 6939942797156278611943887701628585809348645394715431738748649172036955120209;

    uint256 constant IC18x = 4194438191165962932523723306841808344784458025114163283860141220401916404957;
    uint256 constant IC18y = 7706542773259250850175523902868491780101903260892749496944215054088600092962;

    uint256 constant IC19x = 17496330217062371692131114729492545397304911060373206243627742010424530503967;
    uint256 constant IC19y = 3026536715545274646630392332066290769236671169766558083485496779804862985511;

    uint256 constant IC20x = 16416326798921840035271398370445575156048735941204165904029595661551078809247;
    uint256 constant IC20y = 7808604969149213862344951257438521751803034334779037768630273246949818092070;

    uint256 constant IC21x = 7371781633904829156162951605943844895651883866229962600421451646855449842943;
    uint256 constant IC21y = 12688639694808327615250859367922587596543389191631796111787999462532294801784;

    uint256 constant IC22x = 13346589996892042437074276304173305262601558709606101177149535827041373831608;
    uint256 constant IC22y = 9706491061012237591889197256417019679302342666663309123683198956075308602423;

    uint256 constant IC23x = 16049109901008679639473289309383171067372219459132792948501087451380183428780;
    uint256 constant IC23y = 6351580864847506619781420385613564207743126216248333726062863780179826172155;

    uint256 constant IC24x = 20781354690892483784594068930620366553953134647726285612961464874154679281452;
    uint256 constant IC24y = 10398978828001184218722703838083288415874146224615423290339895266417714605684;

    uint256 constant IC25x = 8930626979285788736581990033859267545518862973647967885202145630186902091232;
    uint256 constant IC25y = 7604835213565041738792297346153560599396376699969069004330311559883324881234;


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
