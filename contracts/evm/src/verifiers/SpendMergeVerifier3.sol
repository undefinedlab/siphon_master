// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 merge3 zkey sha256=72e5a9a10f70d4a5e58af0f96d4c09c748f0ef511c87ef7a5746b460ea607de5
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

contract SpendMergeVerifier3 {
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


    uint256 constant IC0x = 20055517264994621345104419137473402595858621326884350015915517185250501653139;
    uint256 constant IC0y = 3527140633858702066070231477602178342087730932493152094371910824130276417489;

    uint256 constant IC1x = 17323137446698733162464823465625361056631929908287249147920018744248313655689;
    uint256 constant IC1y = 14860643762641208694025834978239031820809264320901760377630055600643614085784;

    uint256 constant IC2x = 11644609158369572549969249698314675062864042669223374612371286965831284375083;
    uint256 constant IC2y = 952071334074232771570247907320120573667182597733724246613785721119274621514;

    uint256 constant IC3x = 6289547463797437533621865885567496955874213280624526946260512131207018479276;
    uint256 constant IC3y = 10253701712876597467646620003823739770047916268282585875420560657328705708977;

    uint256 constant IC4x = 20362353955293203451762685869038905959981229376298645063869602961858766134958;
    uint256 constant IC4y = 21579337849817686305596954237227231946972049228651385161008952079592977460301;

    uint256 constant IC5x = 13907071155516416215594049898342277134428787538762751972816502375714922435304;
    uint256 constant IC5y = 18070238274724601008149385488015312192724418132562325695732518955228272886825;

    uint256 constant IC6x = 9855866534802740139777757357282954635060476649082147828184553056633603861125;
    uint256 constant IC6y = 21766538610743913269858283543091590019173600245981587233869212081036157287418;

    uint256 constant IC7x = 668563438223924640082868098852067508226969538468411528689153150556733128086;
    uint256 constant IC7y = 16321420202357254527040230972084551991640358658305687560736832345413193905211;

    uint256 constant IC8x = 8867508309849850607778598745652738202908811576441701192933834991030115338430;
    uint256 constant IC8y = 14371870114364193447495226522111301954583053206381418706523669367793478506128;

    uint256 constant IC9x = 18275823003448149260447602421858579773492676189185035111259818939109648277718;
    uint256 constant IC9y = 21094443682417417993330402526168817390629882190964805547506613024914835039466;

    uint256 constant IC10x = 13812902306113385873435744558662381291843058244078372462037341194836150709187;
    uint256 constant IC10y = 1255886792825434176160600364831693908530235047175929262323284355057966177771;

    uint256 constant IC11x = 16312257662071993556814925608652392477648300503743839903872870399598046992182;
    uint256 constant IC11y = 5731364874410724202703358609257287656636912418184577243958416562265321644460;

    uint256 constant IC12x = 9229034437340965603466326502476591632156225984610561555961575281098388884393;
    uint256 constant IC12y = 20101851973851437402068432965115947265327401643075920417614531030221950827775;

    uint256 constant IC13x = 14083044619193333447074886637028388235504378875701440719011515338556042672234;
    uint256 constant IC13y = 11739034221652037443674566743564100747737333030860199043490563105997027740555;

    uint256 constant IC14x = 356852352554407542112400582769856638713826080305286530975670995344543298396;
    uint256 constant IC14y = 9560174527440452532405659241188010486786530449499891615049355842825636563430;

    uint256 constant IC15x = 10589823276969086761481273457322444345207089826955901462882622464355896438377;
    uint256 constant IC15y = 5106627714553066309173505006303235286176243422118891459659198672853814069847;

    uint256 constant IC16x = 10242460333504036251000005833165587651760891689733071245236811905327394679793;
    uint256 constant IC16y = 16342885485799525004785874808854586884909455583773395185188151982221899811878;

    uint256 constant IC17x = 4850548964283325373198081478830068947485674260957089862186087239949888102019;
    uint256 constant IC17y = 11207457899186770918827044256268636118304409300926484160853645615353955027594;

    uint256 constant IC18x = 15846146957012727270394561939441057376710917068398588329560656361043962557303;
    uint256 constant IC18y = 3069146812750355844236607324483811287289859565764944706547851125752383066946;

    uint256 constant IC19x = 12892160853912105324999015233620076580106774197398176300566424805207580061736;
    uint256 constant IC19y = 17579824612552947770754954195443339086853599006437156543165021489613035355012;

    uint256 constant IC20x = 5463202030149350303350891595331311738840965291510704796241533605483485751858;
    uint256 constant IC20y = 614888116626392258236660461197609499556042607277682356421788404085020362159;

    uint256 constant IC21x = 162744719453543676701474716797673436017745329482719381908730755181395690141;
    uint256 constant IC21y = 4242253119446816340816785776634371996830429507448735506485113151979153819282;

    uint256 constant IC22x = 15801098877810961054858059190816254081961805017010286796689880371074768604506;
    uint256 constant IC22y = 16688599239911855611436497165208060725554570486566364228119738186261293171220;

    uint256 constant IC23x = 5963297947112487057017632596292002198260305452396437615630611011612317856891;
    uint256 constant IC23y = 7751050934002874800147551816269669324254591933867294372699389086193339151861;

    uint256 constant IC24x = 17977591515065705444720416893920298815346165533519445290694252629164938570261;
    uint256 constant IC24y = 15559442554863767190139772990666112703339219135382362517305307203506635842035;

    uint256 constant IC25x = 1621269153047639837504309306696419644288835336568486492732421054848208021302;
    uint256 constant IC25y = 16174457034255500547603073146341868228700470236810452454202277952831745922250;


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
