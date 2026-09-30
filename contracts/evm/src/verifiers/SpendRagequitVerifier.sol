// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 ragequit zkey sha256=15ce452e9b60b51341e2ef0b481a98e5b2be26e76fe6305c0701b74b92006c45
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

contract SpendRagequitVerifier {
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


    uint256 constant IC0x = 18231944819601730206259807800979642869717632629985582602059139014758787546155;
    uint256 constant IC0y = 20991573248257275075701698554849378286604008332289857674211177715496377019741;

    uint256 constant IC1x = 8189433124753053427226420645382163859439983305901257464507731982475490610159;
    uint256 constant IC1y = 409238286230007325487103625048134845125794618498501590234301211992476759841;

    uint256 constant IC2x = 10213446919630321281901914726481213135315969732496915526430698397440932376484;
    uint256 constant IC2y = 13315092212375140770114914567560545693456297193268498838650276724014259300575;

    uint256 constant IC3x = 4294344561478802130284548596273485686750759882914848263271144658174763123177;
    uint256 constant IC3y = 20924262151007614144334885427009676289538653696062337000676402871446375822650;

    uint256 constant IC4x = 6797934867608428732905498304190943819794432445570935029649686370013111354415;
    uint256 constant IC4y = 6711503099347766687352670203373532111492879296808925958827508622776414926742;

    uint256 constant IC5x = 15376300035992958683025025123859058985782838263547917670259443502958419567748;
    uint256 constant IC5y = 2518190551824418499323265271194560779742448577301519600516506815799353278968;

    uint256 constant IC6x = 15851884859011539255354644931532886907450965090401393920112430393749285299;
    uint256 constant IC6y = 14281468225282863333126570025854754963920146416214073262493144900789534443129;

    uint256 constant IC7x = 11564077842076254880236727849780689715317471124478770642715283132005991630530;
    uint256 constant IC7y = 19759077273705151995238740506655772771836814204217019879155757887432202707347;

    uint256 constant IC8x = 5052902409037454506433105476739314254870204892481070598761972220948724857593;
    uint256 constant IC8y = 9716575262962177385399382714018603813860436244509344369875105428051088166420;

    uint256 constant IC9x = 12507045079114069404105475006382197017213670537597289619410895098894165164935;
    uint256 constant IC9y = 16658343797596154721033257737391035896646945289283808156846738263529293482220;

    uint256 constant IC10x = 153484217125883171265687218192446044401076709044356900678711033733333303427;
    uint256 constant IC10y = 17329609237802903454236361046604450723186155827504830083053659533134500947749;

    uint256 constant IC11x = 6937261143090704865481549597909980957049236441098647642354852840583377418851;
    uint256 constant IC11y = 278202659085057950375401909051520849286206984232611490379174811337479045787;

    uint256 constant IC12x = 9326950776488741929361398441643001889005201092232607934213228091484633721259;
    uint256 constant IC12y = 16527629654915727762360793556050964161703558336210819695295112838701965298718;

    uint256 constant IC13x = 11481954279062647632309489462033907520823872145010167359268141627179182205605;
    uint256 constant IC13y = 5960281509928499380270039184614710052011558687916369901418330863274609327906;

    uint256 constant IC14x = 11672263665243078519666628234262906563781182634350163947986552534246876012914;
    uint256 constant IC14y = 19671652720222955136515686527751223611826202551082709229752888810906867800928;

    uint256 constant IC15x = 9200060835771488514377540762991665701079089910797445176720247009169224540494;
    uint256 constant IC15y = 9718226253566666531683428051712927422934718329889337478482418087400947240568;

    uint256 constant IC16x = 3632619854477517913830333808991004063883318594065858624657832195657087310481;
    uint256 constant IC16y = 5242992579486890466321650685759913879742055115267015484891524824150467446535;

    uint256 constant IC17x = 19982037197005484810245279520589037735206057388501157731688170625741907816545;
    uint256 constant IC17y = 10767919374802659810043751934064957044947635108454985194388131669420958727200;

    uint256 constant IC18x = 13019950035024928284800637534242778185676908665465400357946028229925666693743;
    uint256 constant IC18y = 24223242060248598881528548370294395213850398921952276249320160874529050256;

    uint256 constant IC19x = 19801862205572169114712224738052170256009894990521744091592313670178712502205;
    uint256 constant IC19y = 11438211672749245416479704275540710383599308276086544747032337048392851655247;

    uint256 constant IC20x = 4692084393143983419736152594910334339686897562855770096697070826543886304878;
    uint256 constant IC20y = 19323303594016610377192563171492198420606404345861955704760260637975805082699;

    uint256 constant IC21x = 9547491835986784109568277335445351852377723548948758172695492833913145561073;
    uint256 constant IC21y = 1496755611771129992772528415303726386251424364410155225605992662567503032003;

    uint256 constant IC22x = 14405203961485980381442802793684289983739558849005367887909324880738634729390;
    uint256 constant IC22y = 2457645830778939368536875267913377383005889339469105254937439901933105459435;

    uint256 constant IC23x = 8705914347244288590451314384362112530582430117622931663082754087976130821965;
    uint256 constant IC23y = 9337855797446809423314764922560953280691721075232370716182684033488327755391;

    uint256 constant IC24x = 2971501686944913986944033024527867077450108033377888826251837697532766250403;
    uint256 constant IC24y = 19388752638824547066014992277919893594163115405126591864843558344634308481056;

    uint256 constant IC25x = 18508882110832071863026585024061595163356291501704827856267937659692116432860;
    uint256 constant IC25y = 21348162055969315647031884345343266882762522058609038534671524736324753613152;


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
